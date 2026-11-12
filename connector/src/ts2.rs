//! TeamSpeak 2 client (experimental, `--server-type=ts2`).
//!
//! TS2 is a plain UDP protocol, unrelated to TS3. Layouts come from the
//! Wireshark dissector (`packet-teamspeak2.c`) and the soliloque-server
//! reimplementation, checked against a real 2.0.24.1 server.
//!
//! Packet classes (all little endian):
//! - `0xbef4` connection: class, type, session, client id, counter, CRC @16, payload @20
//! - `0xbef0` reliable: same plus resend count @16, fragment @18, CRC @20, payload @24
//! - `0xbef1` ACK: class, 0, session, client id, acked seq (16 bytes, no CRC)
//! - `0xbef2`/`0xbef3` voice, client -> server / server -> client
//!
//! CRC is zlib CRC32 over the whole packet with the CRC field zeroed.
//! Speaks the same stdout/stdin line protocol as the TS3 path in main.rs.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::mem::MaybeUninit;
use std::net::SocketAddr;
use std::os::raw::{c_char, c_int, c_void};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UdpSocket;

use crate::{Args, ChannelInfo, ClientInfo, Event, emit};

const DEFAULT_PORT: u16 = 8767;
const KEEPALIVE_EVERY: Duration = Duration::from_secs(3);
const RESEND_AFTER: Duration = Duration::from_secs(1);
const MAX_RESENDS: u16 = 10;
const SERVER_TIMEOUT: Duration = Duration::from_secs(20);
/// Speex narrowband: 20 ms frames of 160 samples at 8 kHz, 5 per voice packet.
const SPEEX_FRAME: usize = 160;
const FRAMES_PER_PACKET: usize = 5;
/// Start playing a speaker once this many 8 kHz samples are queued. Packets
/// carry 100 ms each, so this waits for the second packet - TS2 clients
/// send in bursts and anything less underruns on ordinary jitter.
const PREBUFFER: usize = SPEEX_FRAME * FRAMES_PER_PACKET + 1;

const ST_CHANNEL_COMMANDER: u16 = 1;
const ST_AWAY: u16 = 8;
const ST_MUTE_MIC: u16 = 16;
const ST_MUTE_SPEAKERS: u16 = 32;
const CH_PASSWORD: u8 = 4;

fn crc(pkt: &mut [u8], at: usize) {
	pkt[at..at + 4].fill(0);
	let h = crc32(pkt);
	pkt[at..at + 4].copy_from_slice(&h.to_le_bytes());
}

/// zlib's CRC32 (IEEE, reflected). Small enough that a dependency isn't worth it.
fn crc32(data: &[u8]) -> u32 {
	let mut c = !0u32;
	for &b in data {
		c ^= b as u32;
		for _ in 0..8 {
			c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
		}
	}
	!c
}

/// TS2 strings are Latin-1. Fixed fields are a length byte plus 29 bytes.
fn latin1(b: &[u8]) -> String {
	b.iter().map(|&c| c as char).collect()
}
fn to_latin1(s: &str) -> Vec<u8> {
	s.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect()
}
fn pstr(s: &str) -> [u8; 30] {
	let mut out = [0u8; 30];
	let b = to_latin1(s);
	let n = b.len().min(29);
	out[0] = n as u8;
	out[1..1 + n].copy_from_slice(&b[..n]);
	out
}
fn rpstr(b: &[u8], at: usize) -> String {
	let Some(&n) = b.get(at) else { return String::new() };
	let end = (at + 1 + (n as usize).min(29)).min(b.len());
	latin1(b.get(at + 1..end).unwrap_or(&[]))
}
/// Null-terminated string at `*at`, advancing past the terminator.
fn rcstr(b: &[u8], at: &mut usize) -> String {
	let start = (*at).min(b.len());
	let end = b[start..].iter().position(|&c| c == 0).map_or(b.len(), |p| start + p);
	*at = end + 1;
	latin1(&b[start..end])
}
fn u16_at(b: &[u8], at: usize) -> u16 {
	b.get(at..at + 2).map_or(0, |s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32_at(b: &[u8], at: usize) -> u32 {
	b.get(at..at + 4).map_or(0, |s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn codec_name(codec: u16) -> String {
	match codec {
		0 => "CELP 5.1",
		1 => "CELP 6.3",
		2 => "GSM 14.8",
		3 => "GSM 16.4",
		4 => "CELP Windows 5.2",
		5 => "Speex 3.4",
		6 => "Speex 5.2",
		7 => "Speex 7.2",
		8 => "Speex 9.3",
		9 => "Speex 12.3",
		10 => "Speex 16.3",
		11 => "Speex 19.5",
		12 => "Speex 25.9",
		_ => "unknown",
	}
	.into()
}

/// Speex narrowband submode per TS2 codec id. Derived from the fixed voice
/// payload sizes (e.g. 138 bytes = 5 frames of submode 4's 220 bits); the
/// server rejects packets of any other size.
fn speex_submode(codec: u8) -> Option<c_int> {
	Some(match codec {
		5 => 1,
		6 => 8,
		7 => 2,
		8 => 3,
		9 => 4,
		10 => 5,
		11 => 6,
		12 => 7,
		_ => return None,
	})
}
/// Bytes of Speex data per voice packet, indexed by codec id.
const SPEEX_BYTES: [usize; 13] = [0, 0, 0, 0, 0, 27, 50, 75, 100, 138, 188, 228, 308];

// --- Speex -------------------------------------------------------------------

struct Bits(Box<speex_sys::SpeexBits>);
impl Bits {
	fn new() -> Self {
		let mut b: Box<MaybeUninit<speex_sys::SpeexBits>> = Box::new(MaybeUninit::uninit());
		// SAFETY: speex_bits_init fully initialises the struct.
		unsafe {
			speex_sys::speex_bits_init(b.as_mut_ptr());
			Bits(Box::from_raw(Box::into_raw(b).cast()))
		}
	}
}
impl Drop for Bits {
	fn drop(&mut self) {
		unsafe { speex_sys::speex_bits_destroy(&mut *self.0) }
	}
}
// The raw state pointers are only ever touched from the one task that owns them.
unsafe impl Send for Bits {}

struct Decoder {
	st: *mut c_void,
	bits: Bits,
}
unsafe impl Send for Decoder {}
impl Decoder {
	fn new() -> Self {
		unsafe {
			let st = speex_sys::speex_decoder_init(speex_sys::speex_lib_get_mode(speex_sys::SPEEX_MODEID_NB));
			let mut on: c_int = 1;
			speex_sys::speex_decoder_ctl(st, speex_sys::SPEEX_SET_ENH, (&mut on as *mut c_int).cast());
			Decoder { st, bits: Bits::new() }
		}
	}
	/// Decodes one voice packet's worth of frames to 8 kHz samples.
	fn decode(&mut self, data: &[u8]) -> Vec<i16> {
		let mut out = vec![0i16; SPEEX_FRAME * FRAMES_PER_PACKET];
		unsafe {
			speex_sys::speex_bits_read_from(&mut *self.bits.0, data.as_ptr() as *mut c_char, data.len() as c_int);
			for frame in out.chunks_mut(SPEEX_FRAME) {
				if speex_sys::speex_decode_int(self.st, &mut *self.bits.0, frame.as_mut_ptr()) != 0 {
					break;
				}
			}
		}
		out
	}
}
impl Drop for Decoder {
	fn drop(&mut self) {
		unsafe { speex_sys::speex_decoder_destroy(self.st) }
	}
}

struct Encoder {
	st: *mut c_void,
	bits: Bits,
	codec: u8,
	frames: usize,
}
unsafe impl Send for Encoder {}
impl Encoder {
	fn new(codec: u8) -> Option<Self> {
		let mut submode = speex_submode(codec)?;
		unsafe {
			let st = speex_sys::speex_encoder_init(speex_sys::speex_lib_get_mode(speex_sys::SPEEX_MODEID_NB));
			speex_sys::speex_encoder_ctl(st, speex_sys::SPEEX_SET_MODE, (&mut submode as *mut c_int).cast());
			Some(Encoder { st, bits: Bits::new(), codec, frames: 0 })
		}
	}
	/// Feeds one 8 kHz frame; returns a full packet payload every fifth frame.
	fn push(&mut self, frame: &mut [i16; SPEEX_FRAME]) -> Option<Vec<u8>> {
		unsafe { speex_sys::speex_encode_int(self.st, frame.as_mut_ptr(), &mut *self.bits.0) };
		self.frames += 1;
		if self.frames < FRAMES_PER_PACKET {
			return None;
		}
		self.frames = 0;
		let mut out = vec![0u8; SPEEX_BYTES[self.codec as usize]];
		debug_assert_eq!(unsafe { speex_sys::speex_bits_nbytes(&mut *self.bits.0) } as usize, out.len());
		unsafe {
			speex_sys::speex_bits_write(&mut *self.bits.0, out.as_mut_ptr() as *mut c_char, out.len() as c_int);
			speex_sys::speex_bits_reset(&mut *self.bits.0);
		}
		Some(out)
	}
}
impl Drop for Encoder {
	fn drop(&mut self) {
		unsafe { speex_sys::speex_encoder_destroy(self.st) }
	}
}

// --- State ---------------------------------------------------------------------

struct Channel {
	id: u32,
	flags: u8,
	codec: u16,
	parent: u32,
	order: u16,
	max_users: u16,
	name: String,
	topic: String,
}
struct Player {
	channel: u32,
	status: u16,
	name: String,
}

/// Parses one channel record (list and "created" share the layout).
fn parse_channel(b: &[u8], at: &mut usize) -> Option<Channel> {
	let o = *at;
	if b.len() < o + 16 {
		return None;
	}
	*at += 16;
	let name = rcstr(b, at);
	let topic = rcstr(b, at);
	let _description = rcstr(b, at);
	Some(Channel {
		id: u32_at(b, o),
		flags: b[o + 4],
		codec: u16_at(b, o + 6),
		parent: u32_at(b, o + 8),
		order: u16_at(b, o + 12),
		max_users: u16_at(b, o + 14),
		name,
		topic,
	})
}

struct Speaker {
	decoder: Decoder,
	queue: VecDeque<i16>,
	playing: bool,
}

struct Ts2 {
	sock: UdpSocket,
	session: u32,
	client_id: u32,
	conn_counter: u32,
	seq: u32,
	/// Reliable packets waiting to go out. TS2 is stop-and-wait: only the
	/// front one is in flight until the server ACKs it.
	outbox: VecDeque<Vec<u8>>,
	in_flight: Option<(Instant, u16)>,
	next_in: u32,
	early: BTreeMap<u32, Vec<u8>>,
	fragments: Vec<u8>,
	fragment_type: u16,
	channels: BTreeMap<u32, Channel>,
	players: BTreeMap<u32, Player>,
	lists_done: bool,
	speakers: HashMap<u32, Speaker>,
	talking: HashSet<u32>,
	encoder: Option<Encoder>,
	voice_counter: u16,
	voice_conversation: u16,
	last_audio_in: Option<Instant>,
	codec_warned: bool,
}

impl Ts2 {
	fn reliable(&mut self, typ: u16, payload: &[u8]) {
		let mut p = Vec::with_capacity(24 + payload.len());
		p.extend_from_slice(&0xbef0u16.to_le_bytes());
		p.extend_from_slice(&typ.to_le_bytes());
		p.extend_from_slice(&self.session.to_le_bytes());
		p.extend_from_slice(&self.client_id.to_le_bytes());
		p.extend_from_slice(&self.seq.to_le_bytes());
		p.extend_from_slice(&[0; 8]); // resend count, fragment, CRC
		p.extend_from_slice(payload);
		crc(&mut p, 20);
		self.seq += 1;
		self.outbox.push_back(p);
	}

	async fn pump_outbox(&mut self) -> Result<()> {
		let Some(front) = self.outbox.front_mut() else { return Ok(()) };
		let resends = match self.in_flight {
			None => 0,
			Some((at, _)) if at.elapsed() < RESEND_AFTER => return Ok(()),
			Some((_, n)) if n >= MAX_RESENDS => bail!("The TeamSpeak 2 server stopped answering"),
			Some((_, n)) => n + 1,
		};
		front[16..18].copy_from_slice(&resends.to_le_bytes());
		crc(front, 20);
		self.sock.send(front).await?;
		self.in_flight = Some((Instant::now(), resends));
		Ok(())
	}

	/// Sends the logout, then waits (max 1.5 s) for the server's own "player left"
	/// for us and acks it. Until that ack the server keeps us half-present (it
	/// resends every 100 ms) and lists us to clients joining meanwhile, who never
	/// get a leave for that ghost.
	async fn logout(&mut self) {
		self.reliable(0x012c, &[]);
		let deadline = Instant::now() + Duration::from_millis(1500);
		let mut buf = [0u8; 2048];
		while Instant::now() < deadline {
			if self.pump_outbox().await.is_err() {
				return;
			}
			let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(100), self.sock.recv(&mut buf)).await else { continue };
			let b = &buf[..n];
			match u16_at(b, 0) {
				0xbef0 if b.len() >= 24 => {
					let mut ack = Vec::with_capacity(16);
					ack.extend_from_slice(&0xbef1u16.to_le_bytes());
					ack.extend_from_slice(&0u16.to_le_bytes());
					ack.extend_from_slice(&self.session.to_le_bytes());
					ack.extend_from_slice(&self.client_id.to_le_bytes());
					ack.extend_from_slice(&b[12..16]);
					let _ = self.sock.send(&ack).await;
					if u16_at(b, 2) == 0x0065 && u32_at(b, 24) == self.client_id {
						return;
					}
				}
				_ => {
					let _ = self.on_datagram(b).await;
				}
			}
		}
	}

	async fn keepalive(&mut self) -> Result<()> {
		let mut p = Vec::with_capacity(24);
		p.extend_from_slice(&0xbef4u16.to_le_bytes());
		p.extend_from_slice(&1u16.to_le_bytes());
		p.extend_from_slice(&self.session.to_le_bytes());
		p.extend_from_slice(&self.client_id.to_le_bytes());
		p.extend_from_slice(&self.conn_counter.to_le_bytes());
		p.extend_from_slice(&[0; 4]); // CRC
		crc(&mut p, 16);
		self.conn_counter += 1;
		self.sock.send(&p).await?;
		Ok(())
	}

	fn own_channel(&self) -> u32 {
		self.players.get(&self.client_id).map_or(0, |p| p.channel)
	}

	fn set_status(&mut self, bit: u16, on: bool) {
		let mut status = self.players.get(&self.client_id).map_or(0, |p| p.status);
		status = if on { status | bit } else { status & !bit };
		if let Some(p) = self.players.get_mut(&self.client_id) {
			p.status = status;
		}
		self.reliable(0x0130, &status.to_le_bytes());
		self.snapshot();
	}

	fn send_text(&mut self, kind: u8, target: u32, message: &str) {
		let mut p = Vec::new();
		p.extend_from_slice(&0u32.to_le_bytes()); // colour
		p.push(kind);
		p.extend_from_slice(&target.to_le_bytes());
		p.extend_from_slice(&to_latin1(message));
		p.push(0);
		self.reliable(0x01ae, &p);
	}

	fn snapshot(&self) {
		if !self.lists_done {
			return;
		}
		let channels = self
			.channels
			.values()
			.map(|c| ChannelInfo {
				id: c.id as u64,
				parent: if c.parent == u32::MAX { 0 } else { c.parent as u64 },
				order: c.order as u64,
				name: c.name.clone(),
				topic: c.topic.clone(),
				codec: codec_name(c.codec),
				max_clients: (c.max_users > 0).then_some(c.max_users),
				has_password: c.flags & CH_PASSWORD != 0,
			})
			.collect::<Vec<_>>();
		let clients = self
			.players
			.iter()
			.map(|(&id, p)| ClientInfo {
				id: id as u16,
				channel: p.channel as u64,
				name: p.name.clone(),
				input_muted: p.status & ST_MUTE_MIC != 0,
				output_muted: p.status & ST_MUTE_SPEAKERS != 0,
				input_hardware_enabled: true,
				away: p.status & ST_AWAY != 0,
				away_message: String::new(),
				is_channel_commander: p.status & ST_CHANNEL_COMMANDER != 0,
				country: String::new(),
				uid: String::new(),
				database_id: 0,
				channel_group: 0,
				server_groups: Vec::new(),
				has_talk_power: true,
				is_query: false,
				is_streaming: false,
				avatar_hash: String::new(),
			})
			.collect::<Vec<_>>();
		emit(&Event::Channels {
			server_clients_online: clients.len() as u16,
			server_channels_online: channels.len() as u64,
			channels,
			clients,
			own_client_id: self.client_id as u16,
			server_max_clients: 0,
		});
	}

	/// Handles one in-order reliable packet. Returns false once we are gone.
	fn handle(&mut self, typ: u16, b: &[u8]) -> bool {
		if std::env::var_os("TS2_DEBUG").is_some() { eprintln!("in {typ:#06x} {:02x?}", &b[..b.len().min(96)]); }
		match typ {
			0x0006 => {
				let n = u32_at(b, 0);
				let mut at = 4;
				for _ in 0..n {
					let Some(c) = parse_channel(b, &mut at) else { break };
					self.channels.insert(c.id, c);
				}
			}
			0x0007 => {
				let n = u32_at(b, 0) as usize;
				for i in 0..n {
					let o = 4 + i * 44;
					if b.len() < o + 44 {
						break;
					}
					let player = Player { channel: u32_at(b, o + 4), status: u16_at(b, o + 12), name: rpstr(b, o + 14) };
					self.players.insert(u32_at(b, o), player);
				}
				self.lists_done = true;
			}
			0x0064 => {
				let player = Player { channel: u32_at(b, 4), status: u16_at(b, 12), name: rpstr(b, 14) };
				self.players.insert(u32_at(b, 0), player);
			}
			0x0065 | 0x0066 => {
				let id = u32_at(b, 0);
				if id == self.client_id {
					let reason = if typ == 0x0066 { "kicked from the server" } else { "removed from the server" };
					emit(&Event::Disconnected { reason: reason.into() });
					return false;
				}
				self.players.remove(&id);
				self.speakers.remove(&id);
			}
			0x0067 | 0x006d => {
				if let Some(p) = self.players.get_mut(&u32_at(b, 0)) {
					p.channel = u32_at(b, 8);
				}
				if u32_at(b, 0) == self.client_id {
					self.encoder = None;
					self.speakers.clear();
				}
			}
			0x0068 => {
				if let Some(p) = self.players.get_mut(&u32_at(b, 0)) {
					p.status = u16_at(b, 4);
				}
			}
			0x006e => {
				let mut at = 4;
				if let Some(c) = parse_channel(b, &mut at) {
					self.channels.insert(c.id, c);
				}
			}
			0x006f | 0x0070 => {
				let mut at = 8;
				let text = rcstr(b, &mut at);
				if let Some(c) = self.channels.get_mut(&u32_at(b, 0)) {
					if typ == 0x006f { c.name = text } else { c.topic = text }
				}
			}
			0x0071 => {
				if let Some(c) = self.channels.get_mut(&u32_at(b, 0)) {
					c.flags = u16_at(b, 4) as u8;
					c.codec = u16_at(b, 6);
				}
				self.encoder = None;
			}
			0x0073 => {
				self.channels.remove(&u32_at(b, 0));
			}
			0x0074 | 0x0075 => {
				if let Some(c) = self.channels.get_mut(&u32_at(b, 0)) {
					if typ == 0x0074 { c.max_users = u16_at(b, 4) } else { c.order = u16_at(b, 4) }
				}
			}
			// The server refuses a command (seen for chat without the matching text permission).
			0xfc0f => emit(&Event::Error { message: "The TeamSpeak 2 server refused this: you lack the permission.".into() }),
			0x0082 => {
				let from = rpstr(b, 5);
				let mut at = 35;
				let message = rcstr(b, &mut at).trim_end().to_string();
				let own_name = self.players.get(&self.client_id).map(|p| p.name.as_str());
				match b.get(4) {
					Some(0) => emit(&Event::ServerMessage { from, message }),
					Some(2) => {
						// TS2 names the sender only; nicknames are unique per server.
						let partner_id = self.players.iter().find(|(_, p)| p.name == from).map_or(0, |(&id, _)| id as u16);
						let from_self = own_name == Some(from.as_str());
						emit(&Event::PrivateMessage { partner_id, partner_name: from, from_self, message });
					}
					Some(1) => emit(&Event::ChatMessage { from, message }),
					// Kind 0xce: admin broadcast (tcpquery msg), with an empty sender field.
					_ => emit(&Event::ServerMessage { from: String::new(), message }),
				}
				return true;
			}
			_ => return true,
		}
		self.snapshot();
		true
	}

	fn on_voice(&mut self, b: &[u8]) {
		let codec = b.get(3).copied().unwrap_or(0);
		let Some(len) = SPEEX_BYTES.get(codec as usize).copied().filter(|&l| l > 0) else { return };
		// Server voice: 16 bytes header, sender id @16, counter @20, then one
		// codec-specific byte before the Speex data.
		let Some(data) = b.get(23..23 + len) else { return };
		let sender = u32_at(b, 16);
		let speaker = self.speakers.entry(sender).or_insert_with(|| Speaker {
			decoder: Decoder::new(),
			queue: VecDeque::new(),
			playing: false,
		});
		speaker.queue.extend(speaker.decoder.decode(data));
	}

	/// 20 ms tick: mix one frame from every buffered speaker, upsample 8 -> 48 kHz.
	fn audio_tick(&mut self) {
		let mut mix = [0i32; SPEEX_FRAME];
		let mut talking = HashSet::new();
		for (&id, s) in &mut self.speakers {
			if !s.playing && s.queue.len() >= PREBUFFER {
				s.playing = true;
			}
			if !s.playing {
				continue;
			}
			if s.queue.len() < SPEEX_FRAME {
				s.playing = false;
				continue;
			}
			for m in mix.iter_mut() {
				*m += s.queue.pop_front().unwrap_or(0) as i32;
			}
			talking.insert(id);
		}
		if talking != self.talking {
			self.talking = talking;
			emit(&Event::Talkers { clients: self.talking.iter().map(|&id| id as u16).collect() });
		}
		if self.talking.is_empty() {
			return;
		}
		// ponytail: linear interpolation, swap for a proper resampler if it sounds dull.
		let mut bytes = Vec::with_capacity(SPEEX_FRAME * 6 * 4);
		for i in 0..SPEEX_FRAME {
			let a = mix[i];
			let b = mix.get(i + 1).copied().unwrap_or(a);
			for k in 0..6 {
				let v = (a + (b - a) * k / 6).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
				bytes.extend_from_slice(&v.to_le_bytes());
				bytes.extend_from_slice(&v.to_le_bytes());
			}
		}
		emit(&Event::AudioOut { pcm: base64::engine::general_purpose::STANDARD.encode(bytes) });
	}

	/// One 960-sample 48 kHz mono frame from the browser.
	async fn on_mic(&mut self, b64: &str) -> Result<()> {
		let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else { return Ok(()) };
		let codec = self.channels.get(&self.own_channel()).map_or(0, |c| c.codec) as u8;
		if self.encoder.as_ref().is_none_or(|e| e.codec != codec) {
			self.encoder = Encoder::new(codec);
			if self.encoder.is_none() {
				if !self.codec_warned {
					self.codec_warned = true;
					emit(&Event::Error {
						message: format!("Sending voice in {} channels is not supported, only Speex.", codec_name(codec as u16)),
					});
				}
				return Ok(());
			}
		}
		if self.last_audio_in.is_none_or(|t| t.elapsed() > Duration::from_millis(200)) {
			self.voice_conversation = self.voice_conversation.wrapping_add(1);
		}
		self.last_audio_in = Some(Instant::now());
		// 48 -> 8 kHz by averaging each 6 samples, a cheap low-pass.
		let mut frame = [0i16; SPEEX_FRAME];
		for (i, chunk) in raw.chunks_exact(12).take(SPEEX_FRAME).enumerate() {
			let sum: i32 = chunk.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as i32).sum();
			frame[i] = (sum / 6) as i16;
		}
		let Some(data) = self.encoder.as_mut().and_then(|e| e.push(&mut frame)) else { return Ok(()) };
		let mut p = Vec::with_capacity(17 + data.len());
		p.extend_from_slice(&0xbef2u16.to_le_bytes());
		p.push(0);
		p.push(codec);
		p.extend_from_slice(&self.session.to_le_bytes());
		p.extend_from_slice(&self.client_id.to_le_bytes());
		// Native client 2.0.32 order (captured): packet counter, then conversation id.
		// Swapped, the native client sees every packet as a new conversation and stutters.
		p.extend_from_slice(&self.voice_counter.to_le_bytes());
		p.extend_from_slice(&self.voice_conversation.to_le_bytes());
		// Native client sends 5 here too (frames per packet).
		p.push(FRAMES_PER_PACKET as u8);
		p.extend_from_slice(&data);
		self.voice_counter = self.voice_counter.wrapping_add(1);
		self.sock.send(&p).await?;
		Ok(())
	}

	async fn on_datagram(&mut self, b: &[u8]) -> Result<bool> {
		if b.len() < 16 {
			return Ok(true);
		}
		match u16_at(b, 0) {
			0xbef0 if b.len() >= 24 => {
				let seq = u32_at(b, 12);
				let mut ack = Vec::with_capacity(16);
				ack.extend_from_slice(&0xbef1u16.to_le_bytes());
				ack.extend_from_slice(&0u16.to_le_bytes());
				ack.extend_from_slice(&self.session.to_le_bytes());
				ack.extend_from_slice(&self.client_id.to_le_bytes());
				ack.extend_from_slice(&seq.to_le_bytes());
				self.sock.send(&ack).await?;
				if seq >= self.next_in {
					self.early.insert(seq, b.to_vec());
				}
				while let Some(p) = self.early.remove(&self.next_in) {
					self.next_in += 1;
					let typ = u16_at(&p, 2);
					let fragment = u16_at(&p, 18);
					// ponytail: assumes fragments count down to 0 on the last
					// one; only seen unfragmented so far (small test server).
					if fragment != 0 || !self.fragments.is_empty() {
						if self.fragments.is_empty() {
							self.fragment_type = typ;
						}
						self.fragments.extend_from_slice(&p[24..]);
						if fragment != 0 {
							continue;
						}
						let body = std::mem::take(&mut self.fragments);
						if !self.handle(self.fragment_type, &body) {
							return Ok(false);
						}
					} else if !self.handle(typ, &p[24..]) {
						return Ok(false);
					}
				}
			}
			0xbef1 => {
				let seq = u32_at(b, 12);
				let front_seq = self.outbox.front().map(|p| u32_at(p, 12));
				if front_seq == Some(seq) {
					self.outbox.pop_front();
					self.in_flight = None;
				}
			}
			0xbef3 => self.on_voice(b),
			_ => {}
		}
		Ok(true)
	}
}

async fn login(sock: &UdpSocket, args: &Args) -> Result<Vec<u8>> {
	let mut p = Vec::with_capacity(180);
	p.extend_from_slice(&0xbef4u16.to_le_bytes());
	p.extend_from_slice(&3u16.to_le_bytes());
	p.extend_from_slice(&[0; 8]); // session, client id
	p.extend_from_slice(&1u32.to_le_bytes());
	p.extend_from_slice(&[0; 4]); // CRC
	p.extend_from_slice(&pstr("TeamSpeak"));
	p.extend_from_slice(&pstr("Linux"));
	p.extend_from_slice(&[2, 0, 0, 0, 0x20, 0, 0x3c, 0, 1, 1]);
	// Anonymous login: no account name, the server password goes in the
	// password field.
	p.extend_from_slice(&pstr(""));
	p.extend_from_slice(&pstr(args.server_password.as_deref().unwrap_or("")));
	p.extend_from_slice(&pstr(&args.nickname));
	crc(&mut p, 16);
	let mut buf = [0u8; 2048];
	for _ in 0..5 {
		sock.send(&p).await?;
		let deadline = tokio::time::sleep(Duration::from_secs(2));
		tokio::pin!(deadline);
		loop {
			tokio::select! {
				r = sock.recv(&mut buf) => {
					let n = r?;
					if n >= 180 && u16_at(&buf, 0) == 0xbef4 && u16_at(&buf, 2) == 4 {
						return Ok(buf[..n].to_vec());
					}
				}
				_ = &mut deadline => break,
			}
		}
	}
	bail!("No answer from the TeamSpeak 2 server. Check the address and port (default 8767).")
}

pub(crate) async fn run(args: Args) -> Result<()> {
	let target = if args.address.contains(':') { args.address.clone() } else { format!("{}:{DEFAULT_PORT}", args.address) };
	let addr: SocketAddr = tokio::net::lookup_host(&target)
		.await
		.map_err(|e| anyhow!("Could not resolve \"{}\": {e}", args.address))?
		.find(|a| a.is_ipv4())
		.ok_or_else(|| anyhow!("\"{}\" has no IPv4 address", args.address))?;
	if !tsclientlib::resolver::is_allowed_target(&addr.ip()) {
		bail!(
			"Could not connect to \"{}\": it points to a private/internal network address, \
which this gateway does not connect to. (Self-hosting admin? Set ALLOW_PRIVATE_TARGETS=1 for LAN servers.)",
			args.address
		);
	}
	let sock = UdpSocket::bind("0.0.0.0:0").await?;
	sock.connect(addr).await?;

	let reply = login(&sock, &args).await?;
	if reply[89..92] != [0, 0, 0] {
		bail!("The TeamSpeak 2 server rejected the login (wrong server password, or nickname not allowed).");
	}
	// Unlike the 30-byte fields, the welcome message's length byte can go up to 255.
	let welcome_len = reply[180] as usize;
	let welcome_message = latin1(&reply[181..(181 + welcome_len).min(reply.len())]);
	emit(&Event::Connected {
		welcome_message,
		server_name: rpstr(&reply, 20),
		server_max_clients: 0,
		server_version: "TeamSpeak 2".into(),
		server_license: String::new(),
		server_license_id: 0,
		server_banner_url: String::new(),
		identity: String::new(),
	});

	let mut ts = Ts2 {
		sock,
		session: u32_at(&reply, 172),
		client_id: u32_at(&reply, 176),
		conn_counter: 2,
		seq: 1,
		outbox: VecDeque::new(),
		in_flight: None,
		next_in: 1,
		early: BTreeMap::new(),
		fragments: Vec::new(),
		fragment_type: 0,
		channels: BTreeMap::new(),
		players: BTreeMap::new(),
		lists_done: false,
		speakers: HashMap::new(),
		talking: HashSet::new(),
		encoder: None,
		voice_counter: 0,
		voice_conversation: 0,
		last_audio_in: None,
		codec_warned: false,
	};

	// "Channel/Sub" picks a sub-channel; TS2 only nests one level deep.
	let (channel, sub) = args.default_channel.as_deref().unwrap_or("").split_once('/').unwrap_or((args.default_channel.as_deref().unwrap_or(""), ""));
	let mut part2 = vec![1, 0];
	part2.extend_from_slice(&pstr(channel));
	part2.extend_from_slice(&pstr(sub));
	// The password field is only 26 bytes (length + 25), followed by the login reply's CRC.
	let mut pw = pstr(args.channel_password.as_deref().unwrap_or(""));
	pw[0] = pw[0].min(25);
	part2.extend_from_slice(&pw[..26]);
	part2.extend_from_slice(&reply[16..20]);
	part2.extend_from_slice(&[0; 4]);
	ts.reliable(0x0005, &part2);

	let mut stdin = BufReader::new(tokio::io::stdin()).lines();
	let mut keepalive = tokio::time::interval(KEEPALIVE_EVERY);
	let mut audio = tokio::time::interval(Duration::from_millis(20));
	let mut resend = tokio::time::interval(Duration::from_millis(100));
	let mut last_heard = Instant::now();
	let mut buf = [0u8; 4096];

	loop {
		ts.pump_outbox().await?;
		tokio::select! {
			r = ts.sock.recv(&mut buf) => {
				let n = r?;
				last_heard = Instant::now();
				if !ts.on_datagram(&buf[..n]).await? {
					return Ok(());
				}
			}
			line = stdin.next_line() => {
				let Some(l) = line? else {
					ts.logout().await;
					return Ok(());
				};
				let l = l.trim();
				if l == "disconnect" || l.starts_with("disconnect ") {
					ts.logout().await;
					emit(&Event::Disconnected { reason: "client requested".into() });
					return Ok(());
				} else if let Some(rest) = l.strip_prefix("audio ") {
					ts.on_mic(rest).await?;
				} else if let Some(rest) = l.strip_prefix("switch ") {
					let mut parts = rest.trim().splitn(2, ' ');
					if let Ok(id) = parts.next().unwrap_or("").parse::<u32>() {
						let password = parts
							.next()
							.and_then(|p| base64::engine::general_purpose::STANDARD.decode(p).ok())
							.and_then(|b| String::from_utf8(b).ok())
							.unwrap_or_default();
						let mut p = id.to_le_bytes().to_vec();
						p.extend_from_slice(&pstr(&password));
						ts.reliable(0x012f, &p);
					}
				} else if let Some(message) = l.strip_prefix("chat ") {
					let own = ts.own_channel();
					ts.send_text(1, own, message);
				} else if let Some(message) = l.strip_prefix("serverchat ") {
					ts.send_text(0, 0, message);
				} else if let Some((id, message)) = l.strip_prefix("pm ").and_then(|r| r.trim().split_once(' ')) {
					if let Ok(id) = id.parse::<u32>() {
						ts.send_text(2, id, message);
						// TS2 doesn't echo private messages back to the sender.
						let partner_name = ts.players.get(&id).map(|p| p.name.clone()).unwrap_or_default();
						emit(&Event::PrivateMessage { partner_id: id as u16, partner_name, from_self: true, message: message.into() });
					}
				} else if l == "away" || l.starts_with("away ") {
					ts.set_status(ST_AWAY, true);
				} else if l == "unaway" {
					ts.set_status(ST_AWAY, false);
				} else if let Some(v) = l.strip_prefix("muteinput ") {
					ts.set_status(ST_MUTE_MIC, v.trim() == "1");
				} else if let Some(v) = l.strip_prefix("muteoutput ") {
					ts.set_status(ST_MUTE_SPEAKERS, v.trim() == "1");
				}
				// Everything else (permissions, files, streams, ...) has no TS2 equivalent.
			}
			_ = keepalive.tick() => {
				if last_heard.elapsed() > SERVER_TIMEOUT {
					emit(&Event::Disconnected { reason: "connection to the TeamSpeak 2 server timed out".into() });
					return Ok(());
				}
				ts.keepalive().await?;
			}
			_ = audio.tick() => ts.audio_tick(),
			_ = resend.tick() => {}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn crc_matches_zlib() {
		assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
	}

	#[test]
	fn speex_sizes_match_submodes() {
		// Encoding 5 frames must give exactly the size the server expects
		// (checked by the debug_assert in Encoder::push).
		for codec in 5..=12u8 {
			let mut enc = Encoder::new(codec).unwrap();
			let mut out = None;
			for _ in 0..FRAMES_PER_PACKET {
				out = enc.push(&mut [0; SPEEX_FRAME]);
			}
			let data = out.unwrap();
			let mut dec = Decoder::new();
			assert_eq!(dec.decode(&data).len(), SPEEX_FRAME * FRAMES_PER_PACKET);
		}
	}
}
