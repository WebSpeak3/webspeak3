use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::str;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::Result;
use audiopus::coder::Encoder as OpusEncoder;
use base64::Engine;
use clap::Parser;
use futures::prelude::*;
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use tsclientlib::audio::AudioHandler;
use tsclientlib::events::{Event as BookEvent, PropertyId, PropertyValue};
use tsclientlib::messages::c2s::{
	OutChannelAddPermPart, OutChannelClientAddPermPart, OutChannelClientDelPermPart,
	OutChannelClientPermListRequestPart, OutChannelDelPermPart, OutChannelGroupAddPermPart,
	OutChannelGroupDelPermPart, OutChannelGroupPermListRequestPart, OutChannelPermListRequestPart,
	OutClientAddPermPart, OutClientDelPermPart, OutClientMovePart, OutClientPermListRequestPart,
	OutClientPokeRequestPart, OutCreateDirectoryPart, OutDeleteFilePart, OutFileListRequestPart,
	OutRenameFilePart, OutSendTextMessagePart, OutServerGroupAddPermPart, OutServerGroupDelPermPart,
	OutServerGroupPermListRequestPart,
};
use tsclientlib::prelude::*;
use tsclientlib::{
	data, ChannelGroupId, ChannelId, ClientDbId, ClientId, ClientType, CodecEncryptionMode,
	Connection, DisconnectOptions, HostBannerMode, HostMessageMode, Identity, InMessage,
	LicenseType, MaxClients, MessageHandle, MessageTarget, Permission, Reason, ServerGroupId,
	ServerType, StreamItem, TextMessageTargetMode, TsError,
};
use tsproto_packets::commands::{CommandItem, CommandParser};
use tsproto_packets::packets::{AudioData, CodecType, Direction, Flags, OutAudio, OutCommand, PacketType};

/// 20ms frames at 48kHz, which is what TeamSpeak's Opus voice codec expects.
const FRAME_SAMPLES: usize = 960;
/// Upper bound for a file download relayed to the browser (see its use).
const MAX_DOWNLOAD_BYTES: u64 = 25 << 20;
/// Uploads are capped the same way, independent of what the browser checks.
const MAX_UPLOAD_BYTES: u64 = 24 << 20;
/// File transfers cross the gateway in pieces of this size (raw bytes, a
/// multiple of 3 so the base64 pieces can simply be concatenated). One huge
/// line per file made the Node gateway hold several copies of it at once and
/// run out of heap (2026-10-11).
const TRANSFER_CHUNK_BYTES: usize = 192 << 10;
// File transfer bandwidth caps in bytes/s (0 = unlimited), set via the
// "ftlimit <up> <down>" stdin command. Read by the spawned transfer tasks.
static FT_LIMIT_UP: AtomicU64 = AtomicU64::new(0);
static FT_LIMIT_DOWN: AtomicU64 = AtomicU64::new(0);

/// Sleeps long enough that `bytes` took at least bytes/limit seconds.
async fn ft_pace(limit: &AtomicU64, bytes: usize, started: std::time::Instant) {
	let limit = limit.load(Ordering::Relaxed);
	if limit == 0 {
		return;
	}
	let target = Duration::from_secs_f64(bytes as f64 / limit as f64);
	if let Some(rest) = target.checked_sub(started.elapsed()) {
		tokio::time::sleep(rest).await;
	}
}
/// Half-received chunked uploads per connection - each can hold up to
/// MAX_UPLOAD_BYTES until it completes.
const MAX_PARTIAL_UPLOADS: usize = 4;
const MAX_ICON_BYTES: u64 = 512 << 10;
/// Avatars are fetched for everyone in the user's channel without asking;
/// TS3 servers default to a 300 KiB avatar size limit.
const MAX_AVATAR_BYTES: u64 = 512 << 10;
const OUT_CHANNELS: usize = 2;

#[derive(Parser, Debug)]
#[command(author, about = "One-shot bridge: connects to a real TeamSpeak server and reports events as JSON lines on stdout")]
struct Args {
	/// Server address, e.g. "192.168.178.108" or "192.168.178.108:9987"
	#[arg(short, long)]
	address: String,
	/// Nickname to use on the server
	#[arg(short, long, default_value = "Browser User")]
	nickname: String,
	/// Server password, if the server requires one. The secrets below are
	/// normally passed via their env vars (as the gateway does) rather than
	/// as flags, since argv is visible to every process on the host.
	#[arg(long, env = "TS_SERVER_PASSWORD", hide_env_values = true)]
	server_password: Option<String>,
	/// Password for the default channel to join, if it's password-protected
	#[arg(long, env = "TS_CHANNEL_PASSWORD", hide_env_values = true)]
	channel_password: Option<String>,
	/// Channel (name or path, e.g. "Default Channel/Nested") to join on connect,
	/// instead of the server's actual default channel
	#[arg(long)]
	default_channel: Option<String>,
	/// Previously-issued identity (as emitted in the "connected" event's
	/// `identity` field) to reconnect with, so the server sees the same
	/// client UID across sessions. A fresh identity is generated - and
	/// reported back the same way - when omitted or unparseable.
	#[arg(long, env = "TS_IDENTITY", hide_env_values = true)]
	identity: Option<String>,
	/// Server flavour: `teamspeak` (skip TeaSpeak handshake), `teaspeak`
	/// (always handshake), or `auto` (handshake when server sends `teaspeak=1`).
	#[arg(long, default_value = "auto", value_parser = ["auto", "teamspeak", "teaspeak"])]
	server_type: String,
	/// Privilege key / token (`client_default_token` in clientinit).
	#[arg(long, alias = "token", env = "TS_PRIVILEGE_KEY", hide_env_values = true)]
	privilege_key: Option<String>,
}

#[derive(Serialize)]
struct ChannelInfo {
	id: u64,
	parent: u64,
	order: u64,
	name: String,
	topic: String,
	codec: String,
	max_clients: Option<u16>,
	has_password: bool,
}

#[derive(Serialize)]
struct ClientInfo {
	id: u16,
	channel: u64,
	name: String,
	input_muted: bool,
	output_muted: bool,
	input_hardware_enabled: bool,
	away: bool,
	away_message: String,
	is_channel_commander: bool,
	country: String,
	uid: String,
	database_id: u64,
	channel_group: u64,
	server_groups: Vec<u64>,
	/// Whether this client is currently allowed to talk in their channel -
	/// `false` in a moderated channel (one with a talk power requirement)
	/// when the client's talk power is below that requirement and they
	/// haven't been individually granted talk power. Always `true` in a
	/// non-moderated channel.
	has_talk_power: bool,
	/// ServerQuery client (`ClientType::Query`). Always included in the
	/// snapshot; the UI hides these unless the user enables them per favorite.
	is_query: bool,
	/// Whether this client is broadcasting a TS6 Stream/Call right now. This is
	/// the only way a client that joins late learns a stream exists - the server
	/// sends no stream command in that case, so the id has to be fetched with
	/// `requeststreaminfo`. Always `false` on servers that don't report it.
	is_streaming: bool,
	/// `client_flag_avatar`: MD5 of the client's avatar, empty without one. The
	/// file itself is `/avatar_<uid>` in channel 0, fetched by the browser.
	avatar_hash: String,
}

/// Payload for the "streamsetup " stdin command - the `setupstream` args, which
/// TS6 always sends in full. The server answers by broadcasting
/// `notifystreamstarted` with the stream id it assigned; there is no id here
/// because the client does not get to pick one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamSetupPayload {
	name: String,
	/// Source kind. A real TS6 screen share sends 3.
	#[serde(rename = "type")]
	kind: u8,
	bitrate: u32,
	/// Who may join: TS6's Privacy setting (public / contacts / private).
	accessibility: u8,
	/// Connection mode - P2P or via the server's SFU.
	mode: u8,
	/// 0 means unlimited.
	viewer_limit: u32,
	audio: bool,
}

/// Payload for the "streamrespond " stdin command - our reply to a
/// `notifyjoinstreamrequest`. JSON rather than a plain argument line because
/// `offer` is a multi-line SDP and stdin here is line-based.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamRespondPayload {
	id: String,
	clid: u16,
	#[serde(default)]
	msg: String,
	/// The publisher offers, so on accept this carries our whole SDP.
	#[serde(default)]
	offer: String,
	decision: u8,
}

/// Payload for the "serveredit " stdin command - every field is optional so
/// the frontend only needs to send what actually changed. Covers the fields
/// tsclientlib's `Server::edit()` builder exposes named setters for; a few
/// exotic ones (antiflood tuning, quotas, log toggles) have no typed setter
/// upstream and aren't included here.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ServerEditPayload {
	name: Option<String>,
	welcome_message: Option<String>,
	/// `Some("")` clears the password; `None` leaves it unchanged.
	password: Option<String>,
	max_clients: Option<u16>,
	hostmessage: Option<String>,
	/// "none" | "log" | "modal" | "modalquit"
	hostmessage_mode: Option<String>,
	hostbanner_url: Option<String>,
	hostbanner_gfx_url: Option<String>,
	hostbanner_gfx_interval_secs: Option<i64>,
	/// "noadjust" | "adjustignoreaspect" | "adjustkeepaspect"
	hostbanner_mode: Option<String>,
	hostbutton_tooltip: Option<String>,
	hostbutton_url: Option<String>,
	hostbutton_gfx_url: Option<String>,
	nickname: Option<String>,
	phonetic_name: Option<String>,
	/// "perchannel" | "forcedoff" | "forcedon"
	codec_encryption_mode: Option<String>,
}

fn parse_host_message_mode(s: &str) -> Option<HostMessageMode> {
	match s.to_ascii_lowercase().as_str() {
		"none" => Some(HostMessageMode::None),
		"log" => Some(HostMessageMode::Log),
		"modal" => Some(HostMessageMode::Modal),
		"modalquit" => Some(HostMessageMode::Modalquit),
		_ => None,
	}
}

fn parse_host_banner_mode(s: &str) -> Option<HostBannerMode> {
	match s.to_ascii_lowercase().as_str() {
		"noadjust" => Some(HostBannerMode::NoAdjust),
		"adjustignoreaspect" => Some(HostBannerMode::AdjustIgnoreAspect),
		"adjustkeepaspect" => Some(HostBannerMode::AdjustKeepAspect),
		_ => None,
	}
}

fn parse_codec_encryption_mode(s: &str) -> Option<CodecEncryptionMode> {
	match s.to_ascii_lowercase().as_str() {
		"perchannel" => Some(CodecEncryptionMode::PerChannel),
		"forcedoff" => Some(CodecEncryptionMode::ForcedOff),
		"forcedon" => Some(CodecEncryptionMode::ForcedOn),
		_ => None,
	}
}

/// Human-facing entries for the Server tab's log-style notifications
/// (client join/leave/switch, channel group assignment, channel/server
/// changes, own permission errors) - mirrors what the native TS3 client
/// shows inline in the server chat. `rename_all` covers the `kind` tag values
/// and `rename_all_fields` the field names, so this needs no remapping on the
/// gateway side (unlike the snake_case variants below).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ServerLogEntry {
	ClientJoin { client: String, channel: String },
	ClientLeave { client: String },
	ClientChannelSwitch { client: String, from_channel: String, to_channel: String },
	ClientChannelGroupAssigned { client: String, group: String },
	ChannelCreated { channel: String },
	ChannelDeleted { channel: String },
	ChannelEdited { channel: String },
	ServerEdited,
	PermissionError { action: String },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Event {
	#[serde(rename = "connected")]
	Connected {
		welcome_message: String,
		server_name: String,
		server_max_clients: u16,
		server_version: String,
		server_license: String,
		/// Raw id for UI coloring (GTS: 0=none, 1=Private, 2=Premium, 3=Authorized).
		server_license_id: u8,
		server_banner_url: String,
		/// Opaque JSON blob the frontend can store and pass back as `--identity`
		/// on a future connection to keep the same client UID.
		identity: String,
	},
	#[serde(rename = "channels")]
	Channels {
		channels: Vec<ChannelInfo>,
		clients: Vec<ClientInfo>,
		/// Our own client id — frontend must not guess this via nickname match.
		own_client_id: u16,
		/// From `virtualserver_maxclients` (updated via `notifyserverupdated`).
		server_max_clients: u16,
		/// From `virtualserver_clientsonline` when known, else visible client count.
		server_clients_online: u16,
		/// From `virtualserver_channelsonline` when known, else visible channel count.
		server_channels_online: u64,
	},
	#[serde(rename = "chatMessage")]
	ChatMessage { from: String, message: String },
	#[serde(rename = "serverMessage")]
	ServerMessage { from: String, message: String },
	/// A direct (whisper) message. `partner_id`/`partner_name` always identify
	/// the *other* side of the conversation, regardless of who sent it, so the
	/// frontend can group messages into one thread per partner.
	#[serde(rename = "privateMessage")]
	PrivateMessage { partner_id: u16, partner_name: String, from_self: bool, message: String },
	/// Someone poked us. Pokes can only be received here - the server doesn't
	/// echo our own outgoing pokes back to us, unlike text messages.
	#[serde(rename = "poke")]
	Poke { from: String, message: String },
	/// Mixed, decoded PCM audio ready to play: 16-bit signed little-endian,
	/// stereo, 48kHz, base64-encoded.
	#[serde(rename = "audioOut")]
	AudioOut { pcm: String },
	/// Ids of clients currently detected as talking.
	#[serde(rename = "talkers")]
	Talkers { clients: Vec<u16> },
	/// Someone started whispering to us and the whisper settings let it through.
	#[serde(rename = "whisperReceived")]
	WhisperReceived {
		#[serde(rename = "clientId")]
		client_id: u16,
	},
	#[serde(rename = "disconnected")]
	Disconnected { reason: String },
	/// Lost the server (timeout, server restart); tsclientlib is reconnecting
	/// on its own. Followed by "reconnected" once it is back.
	#[serde(rename = "reconnecting")]
	Reconnecting { reason: String },
	#[serde(rename = "reconnected")]
	Reconnected,
	#[serde(rename = "error")]
	Error { message: String },
	/// An "error" that belongs to one file transfer, so the frontend can mark the right one.
	#[serde(rename = "error")]
	TransferError { message: String, cid: u64, path: String },
	/// A "switch" to a password-protected channel was rejected because no (or
	/// the wrong) password was supplied. The frontend should prompt for a
	/// password and retry with it rather than showing a generic error.
	#[serde(rename = "channelPasswordRequired")]
	ChannelPasswordRequired { channel_id: u64 },
	/// Server-tab log notification (client join/leave/switch, channel group
	/// assignment, channel/server changes, own permission errors).
	#[serde(rename = "serverLog")]
	ServerLog {
		#[serde(flatten)]
		entry: ServerLogEntry,
	},
	/// Reply to a "clientconninfo <id>" request - live stats for one client's
	/// connection (ping, packet loss, bytes/packets sent+received).
	#[serde(rename = "clientConnectionInfo")]
	ClientConnectionInfo {
		client_id: u16,
		ping_ms: Option<f64>,
		connected_secs: Option<i64>,
		ip: Option<String>,
		packets_sent: u64,
		bytes_sent: u64,
		packets_received: u64,
		bytes_received: u64,
		packet_loss_percent: f32,
	},
	/// Reply to a "serverconninfo" request - aggregate connection stats for
	/// the whole server-side link.
	#[serde(rename = "serverConnectionInfo")]
	ServerConnectionInfo {
		ping_ms: f64,
		/// Server-side connection/uptime seconds (shown as Uptime, not session time).
		connected_secs: i64,
		packet_loss_percent: f32,
		packets_sent_total: u64,
		bytes_sent_total: u64,
		packets_received_total: u64,
		bytes_received_total: u64,
		bandwidth_sent_last_second: u64,
		bandwidth_received_last_second: u64,
		bandwidth_sent_last_minute: u64,
		bandwidth_received_last_minute: u64,
		filetransfer_bandwidth_sent: u64,
		filetransfer_bandwidth_received: u64,
		filetransfer_bytes_sent: u64,
		filetransfer_bytes_received: u64,
	},
	/// Reply to a "serverlog" request - raw lines from the virtual server's
	/// protocol log (distinct from `ServerLog` above, which is the synthesized
	/// client-join/channel-edit/etc. feed for the Server tab).
	#[serde(rename = "serverProtocolLog")]
	ServerProtocolLog { lines: Vec<String> },
	/// Reply to a "banlist" request.
	#[serde(rename = "banList")]
	BanList { entries: Vec<BanListEntry> },
	/// Reply to a "complainlist" request.
	#[serde(rename = "complainList")]
	ComplainList { entries: Vec<ComplainListEntry> },
	/// Reply to a "messagelist" request.
	#[serde(rename = "offlineMessageList")]
	OfflineMessageList { entries: Vec<OfflineMessageListEntry> },
	/// Reply to a "messageget" request.
	#[serde(rename = "offlineMessage")]
	OfflineMessage {
		message_id: u32,
		client_uid: String,
		subject: String,
		message: String,
		timestamp: String,
	},
	/// Reply to a "channelgrouplist" request.
	#[serde(rename = "channelGroupList")]
	ChannelGroupList { entries: Vec<GroupEntry> },
	/// Reply to a "servergrouplist" request.
	#[serde(rename = "serverGroupList")]
	ServerGroupList { entries: Vec<GroupEntry> },
	/// Reply to a "permoverview" request - the caller's own effective
	/// permissions in their current channel, name-resolved via a cached
	/// "permissionlist" lookup.
	#[serde(rename = "permissionOverview")]
	PermissionOverview { entries: Vec<PermissionOverviewEntry> },
	/// Reply to a "ftlist" request - one channel/path's directory listing.
	#[serde(rename = "fileList")]
	FileList { cid: u64, path: String, entries: Vec<FileListEntry> },
	/// One piece of a requested file download, base64-encoded. `offset` is
	/// the raw byte offset of this piece (0 starts a new download), `done`
	/// marks the last one. Pieces arrive in order.
	#[serde(rename = "fileDownloadChunk")]
	FileDownloadChunk { cid: u64, path: String, offset: u64, data: String, done: bool },
	/// A requested file upload finished successfully.
	#[serde(rename = "fileUploadDone")]
	FileUploadDone { cid: u64, path: String },
	/// Reply to a "permlist <scope> ..." request - the permissions currently
	/// assigned to one server group / channel group / channel / client /
	/// channel+client combination. `scope` and `id1`/`id2` echo what was
	/// requested, so the frontend can route the reply to the right editor tab.
	#[serde(rename = "permList")]
	PermList { scope: String, id1: u64, id2: Option<u64>, entries: Vec<PermissionOverviewEntry> },
	/// Reply to a "permissionlist" request - the full catalog of every
	/// permission the server knows about (not just ones actually assigned
	/// anywhere), for populating an "add permission" picker.
	#[serde(rename = "permissionCatalog")]
	PermissionCatalog { entries: Vec<PermissionCatalogEntry> },
	/// A TS6 Stream/Call command the server sent us, forwarded verbatim.
	///
	/// `tsclientlib` has no declarations for these, so they arrive as
	/// `StreamItem::UnknownCommand` and are only unescaped here - the payload
	/// of `notifystreamsignaling` is an opaque JSON blob (SDP offer/answer,
	/// ICE candidates) that belongs to the browser's `RTCPeerConnection`, not
	/// to the connector. `name` is the raw command name, e.g.
	/// `notifystreamsignaling`.
	#[serde(rename = "streamEvent")]
	StreamEvent { name: String, args: BTreeMap<String, String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BanListEntry {
	ban_id: u32,
	ip: String,
	name: String,
	uid: String,
	last_nickname: String,
	created: String,
	duration_secs: i64,
	invoker_name: String,
	reason: String,
	enforcements: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComplainListEntry {
	target_client_db_id: u64,
	target_name: String,
	from_client_db_id: u64,
	from_name: String,
	message: String,
	timestamp: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineMessageListEntry {
	message_id: u32,
	client_uid: String,
	subject: String,
	timestamp: String,
	is_read: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionOverviewEntry {
	name: String,
	description: String,
	value: i32,
	negated: bool,
	skip: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionCatalogEntry {
	id: u32,
	name: String,
	description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupEntry {
	id: u64,
	name: String,
	icon_id: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileListEntry {
	path: String,
	name: String,
	size: u64,
	is_file: bool,
	timestamp: String,
}

/// Handles one `ftuploadchunk <cid>\t<offset>\t<total>\t<path>\t<base64>`
/// line. Pieces come in order; offset 0 starts an upload. Returns the complete
/// file once the piece that reaches <total> has arrived.
fn take_upload_chunk(
	partials: &mut HashMap<(u64, String), (u64, Vec<u8>)>,
	rest: &str,
) -> Result<Option<(u64, String, Vec<u8>)>, String> {
	let mut parts: Vec<&str> = rest.splitn(5, '\t').collect();
	// The stdin loop trims each line, which eats the trailing tab of an empty piece.
	if parts.len() == 4 {
		parts.push("");
	}
	let [cid, offset, total, path, data] = parts.as_slice() else {
		return Err("Invalid ftuploadchunk args".into());
	};
	let (Ok(cid), Ok(offset), Ok(total), Ok(bytes)) = (
		cid.trim().parse::<u64>(),
		offset.trim().parse::<u64>(),
		total.trim().parse::<u64>(),
		base64::engine::general_purpose::STANDARD.decode(data.trim()),
	) else {
		return Err("Invalid ftuploadchunk args".into());
	};
	let key = (cid, path.to_string());
	if offset == 0 {
		if total > MAX_UPLOAD_BYTES {
			return Err(format!("Upload refused: {path} is larger than {} KiB", MAX_UPLOAD_BYTES >> 10));
		}
		if !partials.contains_key(&key) && partials.len() >= MAX_PARTIAL_UPLOADS {
			return Err("Too many uploads at once".into());
		}
		partials.insert(key.clone(), (total, Vec::with_capacity(total as usize)));
	}
	let Some((expected, buf)) = partials.get_mut(&key) else {
		return Err(format!("Upload failed: {path} has no upload in progress"));
	};
	if buf.len() as u64 != offset || *expected != total || offset + bytes.len() as u64 > total {
		partials.remove(&key);
		return Err(format!("Upload failed: {path} arrived out of order"));
	}
	buf.extend_from_slice(&bytes);
	if (buf.len() as u64) < total {
		return Ok(None);
	}
	let (_, bytes) = partials.remove(&key).expect("present, checked above");
	Ok(Some((cid, key.1, bytes)))
}

fn emit(event: &Event) {
	println!("{}", serde_json::to_string(event).unwrap());
}

fn emit_server_log(entry: ServerLogEntry) {
	emit(&Event::ServerLog { entry });
}

/// Translates a single book-state diff into a Server-tab log entry, when it's
/// one of the changes worth surfacing there (client join/leave/switch,
/// channel group assignment, channel/server changes). Most diffs (e.g.
/// per-field client updates like mute state) are intentionally not logged -
/// only the categories the native client's server log shows for these.
fn log_book_event(con: &data::Connection, event: &BookEvent) {
	match event {
		BookEvent::PropertyAdded { id: PropertyId::Client(client_id), .. } => {
			if let Some(client) = con.clients.get(client_id) {
				let channel = con.channels.get(&client.channel).map(|c| c.name.clone()).unwrap_or_default();
				emit_server_log(ServerLogEntry::ClientJoin { client: client.name.clone(), channel });
			}
		}
		BookEvent::PropertyRemoved { id: PropertyId::Client(_), old: PropertyValue::Client(client), .. } => {
			emit_server_log(ServerLogEntry::ClientLeave { client: client.name.clone() });
		}
		BookEvent::PropertyAdded { id: PropertyId::Channel(channel_id), .. } => {
			if let Some(channel) = con.channels.get(channel_id) {
				emit_server_log(ServerLogEntry::ChannelCreated { channel: channel.name.clone() });
			}
		}
		BookEvent::PropertyRemoved { id: PropertyId::Channel(_), old: PropertyValue::Channel(channel), .. } => {
			emit_server_log(ServerLogEntry::ChannelDeleted { channel: channel.name.clone() });
		}
		BookEvent::PropertyChanged { id: PropertyId::ClientChannel(client_id), old: PropertyValue::ChannelId(old_channel), .. } => {
			if let Some(client) = con.clients.get(client_id) {
				let from_channel = con.channels.get(old_channel).map(|c| c.name.clone()).unwrap_or_default();
				let to_channel = con.channels.get(&client.channel).map(|c| c.name.clone()).unwrap_or_default();
				emit_server_log(ServerLogEntry::ClientChannelSwitch {
					client: client.name.clone(),
					from_channel,
					to_channel,
				});
			}
		}
		BookEvent::PropertyChanged { id: PropertyId::ClientChannelGroup(client_id), .. } => {
			if let Some(client) = con.clients.get(client_id) {
				let group =
					con.channel_groups.get(&client.channel_group).map(|g| g.name.clone()).unwrap_or_default();
				emit_server_log(ServerLogEntry::ClientChannelGroupAssigned { client: client.name.clone(), group });
			}
		}
		BookEvent::PropertyChanged {
			id:
				PropertyId::ChannelName(channel_id)
				| PropertyId::ChannelTopic(channel_id)
				| PropertyId::ChannelMaxClients(channel_id)
				| PropertyId::ChannelMaxFamilyClients(channel_id)
				| PropertyId::ChannelHasPassword(channel_id)
				| PropertyId::ChannelNeededTalkPower(channel_id)
				| PropertyId::ChannelCodec(channel_id)
				| PropertyId::ChannelCodecQuality(channel_id)
				| PropertyId::ChannelIsDefault(channel_id)
				| PropertyId::ChannelDeleteDelay(channel_id)
				| PropertyId::ChannelPhoneticName(channel_id)
				| PropertyId::ChannelIsPrivate(channel_id)
				| PropertyId::ChannelForcedSilence(channel_id)
				| PropertyId::ChannelOrder(channel_id)
				| PropertyId::ChannelParent(channel_id),
			..
		} => {
			if let Some(channel) = con.channels.get(channel_id) {
				emit_server_log(ServerLogEntry::ChannelEdited { channel: channel.name.clone() });
			}
		}
		BookEvent::PropertyChanged {
			id:
				PropertyId::ServerName
				| PropertyId::ServerWelcomeMessage
				| PropertyId::ServerHostmessage
				| PropertyId::ServerHostmessageMode
				| PropertyId::ServerHostbannerUrl
				| PropertyId::ServerHostbannerGfxUrl
				| PropertyId::ServerHostbannerGfxInterval
				| PropertyId::ServerHostbannerMode
				| PropertyId::ServerHostbuttonTooltip
				| PropertyId::ServerHostbuttonUrl
				| PropertyId::ServerHostbuttonGfxUrl
				| PropertyId::ServerPhoneticName
				| PropertyId::ServerIcon
				| PropertyId::ServerMaxClients
				| PropertyId::ServerAskForPrivilegekey
				| PropertyId::ServerDefaultServerGroup
				| PropertyId::ServerDefaultChannelGroup
				| PropertyId::ServerCodecEncryptionMode
				| PropertyId::ServerTempChannelDefaultDeleteDelay
				| PropertyId::ServerPrioritySpeakerDimmModificator,
			// Only notifyserveredited carries an invoker; the 20s
			// servergetvariables poll answers with notifyserverupdated, which
			// rewrites every field (changed or not) without one.
			invoker: Some(_),
			..
		} => {
			emit_server_log(ServerLogEntry::ServerEdited);
		}
		_ => {}
	}
}

/// `Channel::order` is not a plain position, it's the id of the preceding
/// sibling channel (0 = first child of its parent) - effectively a linked
/// list per parent. This resolves that into a plain 0-based sequence index
/// per parent, so the frontend can just sort by it.
fn resolve_order(channels: &[&data::Channel]) -> HashMap<u64, u64> {
	let mut by_parent: HashMap<u64, Vec<&data::Channel>> = HashMap::new();
	for ch in channels {
		by_parent.entry(ch.parent.0).or_default().push(ch);
	}

	let mut result = HashMap::new();
	for (_, mut remaining) in by_parent {
		let mut prev_id = 0u64;
		let mut index = 0u64;
		while !remaining.is_empty() {
			match remaining.iter().position(|ch| ch.order.0 == prev_id) {
				Some(pos) => {
					let ch = remaining.remove(pos);
					result.insert(ch.id.0, index);
					index += 1;
					prev_id = ch.id.0;
				}
				// Broken/incomplete chain: dump the rest rather than loop forever.
				None => {
					for ch in remaining.drain(..) {
						result.insert(ch.id.0, index);
						index += 1;
					}
				}
			}
		}
	}
	result
}

fn snapshot(con: &data::Connection) -> Event {
	let channel_refs: Vec<&data::Channel> = con.channels.values().collect();
	let order = resolve_order(&channel_refs);

	let channels = channel_refs
		.iter()
		.map(|ch| ChannelInfo {
			id: ch.id.0,
			parent: ch.parent.0,
			order: *order.get(&ch.id.0).unwrap_or(&0),
			name: ch.name.clone(),
			topic: ch.topic.clone().unwrap_or_default(),
			codec: format!("{:?}", ch.codec),
			max_clients: match ch.max_clients {
				Some(MaxClients::Limited(n)) => Some(n),
				_ => None,
			},
			has_password: ch.has_password.unwrap_or(false),
		})
		.collect::<Vec<_>>();
	// Bookkeeping includes ServerQuery clients (`ClientType::Query`). We always
	// forward them (with `is_query`) so the UI can toggle visibility live from
	// a favorite setting without reconnecting. Online counts below still exclude
	// Query by default so the headline matches the default (hidden) tree.
	let clients = con
		.clients
		.values()
		.map(|c| {
			// A channel with no talk power requirement at all (the common
			// case) is never moderated, so everyone can talk regardless of
			// their own talk power - matches tsclientlib's own
			// intern_can_send_audio logic for the moderated-channel check.
			let has_talk_power = match con.channels.get(&c.channel).and_then(|ch| ch.needed_talk_power) {
				Some(needed) => c.talk_power_granted || c.talk_power >= needed,
				None => true,
			};
			ClientInfo {
				id: c.id.0,
				channel: c.channel.0,
				name: c.name.clone(),
				input_muted: c.input_muted,
				output_muted: c.output_muted,
				input_hardware_enabled: c.input_hardware_enabled,
				away: c.away_message.is_some(),
				away_message: c.away_message.clone().unwrap_or_default(),
				is_channel_commander: c.is_channel_commander,
				country: c.country_code.clone(),
				uid: c.uid.as_ref().map(|u| u.to_string()).unwrap_or_default(),
				database_id: c.database_id.0,
				channel_group: c.channel_group.0,
				server_groups: c.server_groups.iter().map(|g| g.0).collect(),
				has_talk_power,
				is_query: matches!(c.client_type, ClientType::Query { .. }),
				is_streaming: c.is_streaming.unwrap_or(false),
				avatar_hash: c.avatar_hash.clone(),
			}
		})
		.collect::<Vec<_>>();

	// Prefer server-reported counters (GTS/TS `virtualserver_*` via notifyserverupdated)
	// but never under-report vs. the non-Query client set (stale optional_data
	// after joins would otherwise freeze the InfoPanel left number).
	// `virtualserver_clientsonline` usually includes ServerQuery; subtract them
	// so the default (Query-hidden) headline matches the default tree.
	let opt = con.server.optional_data.as_ref();
	let visible_channels = channels.len() as u64;
	let query_count = clients.iter().filter(|c| c.is_query).count() as u16;
	let visible_clients_count = (clients.len() as u16).saturating_sub(query_count);
	let server_clients_online = opt
		.map(|d| {
			let without_query = d.client_count.saturating_sub(query_count);
			without_query.max(visible_clients_count)
		})
		.unwrap_or(visible_clients_count);
	let server_channels_online =
		opt.map(|d| d.channel_count.max(visible_channels)).unwrap_or(visible_channels);

	Event::Channels {
		channels,
		clients,
		own_client_id: con.own_client.0,
		server_max_clients: con.server.max_clients,
		server_clients_online,
		server_channels_online,
	}
}

/// Splits a raw TS command line into its unescaped key/value pairs.
///
/// Only the first part of a `|`-separated multi-part command is read; none of
/// the stream commands use multiple parts. A flag without `=` becomes an empty
/// string, which is how TeamSpeak treats it too.
fn parse_ts_args(content: &str) -> BTreeMap<String, String> {
	let (_, parser) = CommandParser::new(content.as_bytes());
	let mut args = BTreeMap::new();
	for item in parser {
		match item {
			CommandItem::Argument(arg) => {
				let (Ok(name), Ok(value)) = (str::from_utf8(arg.name()), arg.value().get_str())
				else {
					continue;
				};
				args.insert(name.to_string(), value.into_owned());
			}
			// Stop at the first part boundary.
			CommandItem::NextCommand => break,
		}
	}
	args
}

/// Sends `joinstreamrequest` for a `"<stream-id> <clid> [msg]"` argument line.
///
/// Parameter names and order are as recovered from TS6's `TeamSpeak.dll`; `msg`
/// is written even when empty so the shape matches the native client.
fn send_join_stream_request(con: &mut tsclientlib::Connection, rest: &str, is_remove: bool) {
	let mut parts = rest.splitn(3, ' ');
	let (Some(id), Some(Ok(clid))) = (parts.next(), parts.next().map(|c| c.parse::<u16>())) else {
		emit(&Event::Error { message: "Usage: streamjoin <stream-id> <clid> [msg]".into() });
		return;
	};
	if id.is_empty() {
		emit(&Event::Error { message: "Usage: streamjoin <stream-id> <clid> [msg]".into() });
		return;
	}
	let msg = parts.next().unwrap_or("");

	let mut packet =
		OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "joinstreamrequest");
	packet.write_arg("id", &id);
	packet.write_arg("clid", &clid);
	packet.write_arg("msg", &msg);
	packet.write_arg("is_remove", &u8::from(is_remove));
	if let Err(e) = packet.send(con) {
		emit(&Event::Error { message: format!("joinstreamrequest failed: {e}") });
	}
}

fn send_server_get_variables(con: &mut tsclientlib::Connection) {
	let packet = OutCommand::new(
		Direction::C2S,
		Flags::empty(),
		PacketType::Command,
		"servergetvariables",
	);
	if let Err(e) = packet.send(con) {
		emit(&Event::Error { message: format!("servergetvariables failed: {e}") });
	}
}

#[tokio::main]
async fn main() {
	let args = Args::parse();
	if let Err(e) = run(args).await {
		emit(&Event::Error { message: e.to_string() });
	}
}

/// VoySpeak (formerly GreenTeaSpeak) servers report versions like `2.5.1 [Build: …]`.
/// Classic TeaSpeak reports `TeaSpeak 1.4.21-beta [Build: …]` — not a GTS host.
/// Classic TeamSpeak 3 reports `3.13.8 [Build: …]` — must not use GTS labels.
fn is_greenteaspeak_server_version(version: &str) -> bool {
	let v = version.trim();
	if v.is_empty() {
		return false;
	}
	let lower = v.to_ascii_lowercase();
	if lower.starts_with("teaspeak") || lower.starts_with("3.") {
		return false;
	}
	let mut parts = v.split('.');
	matches!(
		(parts.next(), parts.next(), parts.next()),
		(Some(a), Some(b), Some(c))
			if !a.is_empty()
				&& a.chars().all(|ch| ch.is_ascii_digit())
				&& !b.is_empty()
				&& b.chars().all(|ch| ch.is_ascii_digit())
				&& c.chars().next().is_some_and(|ch| ch.is_ascii_digit())
	)
}

/// Labels match the GreenTeaSpeak desktop client (`formatLicenseLabel`).
fn format_server_license(license: LicenseType, version: &str) -> String {
	if is_greenteaspeak_server_version(version) {
		return match license {
			LicenseType::Offline => "Private".into(),
			LicenseType::Sdk => "Premium".into(),
			LicenseType::SdkOffline => "Authorized VoySpeak Host Provider".into(),
			_ => "Keine Lizenz".into(),
		};
	}
	if version.trim().to_ascii_lowercase().starts_with("teaspeak") {
		return "Kein VoySpeak-Server".into();
	}
	match license {
		LicenseType::NoLicense => "No License".into(),
		LicenseType::Offline => "Offline / LAN".into(),
		LicenseType::Sdk => "SDK".into(),
		LicenseType::SdkOffline => "SDK Offline".into(),
		LicenseType::Npl => "NPL".into(),
		LicenseType::Athp => "ATHP".into(),
		LicenseType::Aal => "AAL".into(),
		LicenseType::Default => "Default".into(),
		LicenseType::Gamer => "Gamer".into(),
		LicenseType::Sponsorship => "Sponsorship".into(),
		LicenseType::Commercial => "Commercial".into(),
	}
}

/// tsclientlib's error `Display` impls mostly fall back to `{:?}` for nested
/// errors (e.g. `Failed to connect to server at "x": [Connect(TsProto(Timeout(..)))]`),
/// which is accurate but not something an end user can act on. Map the cases
/// that come up in practice to plain-language messages instead.
fn friendly_connect_error(address: &str, e: tsclientlib::Error) -> anyhow::Error {
	let raw = e.to_string();
	if raw.contains("client\\stype\\sis\\snot\\sallowed")
		|| raw.contains("client type is not allowed")
		|| raw.contains("id=533")
	{
		return anyhow::anyhow!(
			"Could not connect to \"{address}\": this server rejects this client type (error 533). \
VoySpeak (formerly GreenTeaSpeak) public servers often only allow the official VoySpeak desktop client. \
Try a self-hosted TeaSpeak with TeamSpeak-compat enabled, or use the VoySpeak desktop client."
		);
	}
	if raw.contains("BlockedTarget") {
		return anyhow::anyhow!(
			"Could not connect to \"{address}\": it points to a private/internal network address, \
which this gateway does not connect to. (Self-hosting admin? Set ALLOW_PRIVATE_TARGETS=1 for LAN servers.)"
		);
	}
	match &e {
		tsclientlib::Error::ConnectTs(inner) => {
			anyhow::anyhow!("The server rejected the connection: {inner}")
		}
		tsclientlib::Error::InitserverTimeout => anyhow::anyhow!(
			"The server did not finish logging us in within the timeout - please try again"
		),
		_ if raw.contains("Timeout") => anyhow::anyhow!(
			"Could not reach \"{address}\": connection timed out. Check the address/port and that the server is reachable."
		),
		_ => anyhow::anyhow!("Could not connect to \"{address}\": {e}"),
	}
}

async fn run(args: Args) -> Result<()> {
	// stdout is a strict newline-delimited-JSON channel for the gateway to parse;
	// all diagnostic logging must go to stderr instead.
	//
	// ts_bookkeeping::messages::s2c logs a WARN for every server/property field
	// it doesn't have a parser for - harmless (the field is just ignored) but,
	// on TeaSpeak/GreenTeaSpeak servers especially, noisy enough on every
	// ServerUpdated/ClientEnterView to drown out warnings that actually matter.
	// Downgraded to error by default; RUST_LOG still overrides this entirely
	// when set, e.g. RUST_LOG=debug for full tracing.
	let filter = tracing_subscriber::EnvFilter::try_from_default_env()
		.unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,ts_bookkeeping::messages::s2c=error"));
	tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).init();

	let address = args.address.clone();
	// Accepts either our own persisted JSON blob (serialized below) or a raw
	// TS3 identity string ("<counter>V<base64-key>", the format used by the
	// native client's exported .ini files and teamspeak:// URLs) - the web
	// client's "Identitäten importieren" can hand in either.
	let identity = args
		.identity
		.as_deref()
		.and_then(|s| serde_json::from_str::<Identity>(s).ok().or_else(|| Identity::new_from_str(s).ok()))
		.unwrap_or_else(Identity::create);
	let identity_str = serde_json::to_string(&identity).unwrap();
	let mut con_config = Connection::build(args.address).name(args.nickname).identity(identity);
	let server_type = match args.server_type.as_str() {
		"teaspeak" => ServerType::Teaspeak,
		"teamspeak" => ServerType::Teamspeak,
		_ => ServerType::Auto,
	};
	con_config = con_config.server_type(server_type);
	if let Some(token) = args.privilege_key {
		con_config = con_config.default_token(token);
	}
	if let Some(pwd) = args.server_password {
		con_config = con_config.password(pwd);
	}
	if let Some(pwd) = args.channel_password {
		con_config = con_config.channel_password(pwd);
	}
	if let Some(channel) = args.default_channel {
		con_config = con_config.channel(channel);
	}

	let mut con = con_config.connect().map_err(|e| friendly_connect_error(&address, e))?;

	// Wait for the initial book events (means we're logged in and have server state).
	// Bounded by a timeout: an unreachable host/port otherwise leaves this waiting
	// forever with no error, since tsclientlib only reports failures through this
	// event stream rather than from `connect()` itself.
	const CONNECT_TIMEOUT_SECS: u64 = 15;
	{
		let mut login_events =
			con.events().try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))));
		match tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), login_events.next()).await {
			Ok(Some(r)) => {
				r.map_err(|e| friendly_connect_error(&address, e))?;
			}
			Ok(None) => {}
			Err(_) => {
				anyhow::bail!(
					"Could not reach \"{address}\": connection timed out after {CONNECT_TIMEOUT_SECS}s. Check the address/port and that the server is reachable."
				);
			}
		}
	}

	let server_state = con.get_state()?;
	let welcome_message = server_state.server.welcome_message.clone();
	let server_name = server_state.server.name.clone();
	let server_max_clients = server_state.server.max_clients;
	let server_version = server_state.server.version.clone();
	let server_license = format_server_license(server_state.server.license, &server_version);
	let server_license_id = server_state.server.license.to_u8().unwrap_or(0);
	let server_banner_url = server_state.server.hostbanner_gfx_url.clone();
	emit(&Event::Connected {
		welcome_message,
		server_name,
		server_max_clients,
		server_version,
		server_license,
		server_license_id,
		server_banner_url,
		identity: identity_str,
	});

	// Subscribe to all channels so we actually receive the full channel/client list.
	con.get_state()?.server.set_subscribed(true).send(&mut con)?;

	// Ask for virtualserver_* counters (maxclients / clientsonline / …) like GTS.
	// Reply arrives as notifyserverupdated and updates bookkeeping + snapshots.
	send_server_get_variables(&mut con);

	// Give the server a moment to send the channel/client list, then emit a
	// snapshot. Further snapshots are emitted below whenever book state changes.
	{
		let mut events = con.events().try_filter(|_| future::ready(false));
		tokio::select! {
			_ = tokio::time::sleep(tokio::time::Duration::from_millis(800)) => {}
			_ = events.next() => {}
		}
	}
	emit(&snapshot(con.get_state()?));

	// Main loop: relay book updates as fresh snapshots, watch stdin for a
	// "disconnect" command, watch the connection for the server hanging up.
	let mut stdin_lines = BufReader::new(tokio::io::stdin()).lines();

	let opus_encoder = OpusEncoder::new(
		audiopus::SampleRate::Hz48000,
		audiopus::Channels::Mono,
		audiopus::Application::Voip,
	)?;
	let mut audio_handler = AudioHandler::<ClientId>::new();
	let mut talking: HashSet<u16> = HashSet::new();
	// Per-speaker playback volume set by the browser (`clientvolume`). Kept
	// outside the AudioHandler because its queues only live while someone
	// talks; a new queue picks its volume up from here.
	let mut client_volumes: HashMap<u16, f32> = HashMap::new();
	let mut audio_ticker = tokio::time::interval(tokio::time::Duration::from_millis(20));
	// Commands sent via `send()` fail silently if the server rejects them (e.g.
	// missing permission) - no reply is sent back without a return code. Using
	// `send_with_result()` for text messages gets us a `MessageResult` event we
	// can surface as a visible error instead of the message just vanishing.
	let mut pending_messages: HashMap<MessageHandle, String> = HashMap::new();
	// Tracks which channel a pending "Channel switch" MessageResult is for, so
	// a ChannelInvalidPassword failure can be reported as ChannelPasswordRequired
	// for that specific channel instead of a generic error.
	let mut pending_switch_channel: HashMap<MessageHandle, u64> = HashMap::new();
	// When non-empty, outgoing voice is whispered to just these channels/clients
	// instead of being sent to the current channel - set via the "whisper "
	// stdin command, cleared via "unwhisper".
	let mut whisper_channels: Vec<u64> = Vec::new();
	let mut whisper_clients: Vec<u16> = Vec::new();
	// Incoming whispers, set via "whisperpolicy allow|block;<client ids>": the
	// ids are exceptions to the mode. Blocked whispers are dropped undecoded.
	let mut whisper_block_default = false;
	let mut whisper_exceptions: HashSet<u16> = HashSet::new();
	// Set by "clientconninfo"/"serverconninfo" while waiting for the server's
	// reply to land in book state (it arrives async as a later BookEvents
	// batch, not as a direct command result) - checked and emitted below.
	let mut pending_client_conninfo: Option<ClientId> = None;
	let mut pending_server_conninfo = false;
	// Set by "serverlog" while waiting for the notifyserverlog reply, which
	// arrives as a StreamItem::MessageEvent (not a BookEvents batch, since log
	// lines aren't part of the channel/client/server data model).
	let mut pending_server_log = false;
	let mut pending_ban_list = false;
	let mut pending_complain_list = false;
	let mut pending_offline_message_list = false;
	let mut pending_offline_message_get = false;
	let mut pending_channel_group_list = false;
	let mut pending_server_group_list = false;
	// Cache of permission id -> (name, description), built lazily from a
	// "permissionlist" request the first time a "permoverview" is requested;
	// the mapping is static for the lifetime of the connection so it's only
	// fetched once.
	let mut permission_names: std::collections::HashMap<u32, (String, String)> =
		std::collections::HashMap::new();
	// notifypermissionlist never fills in `permission_id` on its entries (it's
	// always None) - the catalog only carries name/description, and the
	// numeric ID is implicit in each entry's position in the stream (0-based,
	// incrementing across every chunk in arrival order). This tracks that
	// running position across chunks while a catalog fetch is in flight.
	let mut permission_catalog_next_id: u32 = 0;
	let mut pending_permission_list = false;
	let mut pending_perm_overview = false;
	// Raw permoverview entries received before the permission-name cache was
	// ready get buffered here and re-emitted once the names arrive.
	let mut pending_perm_overview_raw: Option<Vec<(u32, i32, bool, bool)>> = None;
	// Set by "ftlist" while a directory listing is in flight - the server
	// replies with one notifyfilelist packet per entry (buffered here), then a
	// final notifyfilelistfinished that triggers the actual emit.
	let mut pending_file_list: Option<(u64, String)> = None;
	let mut file_list_buffer: Vec<FileListEntry> = Vec::new();
	// client_filetransfer_id -> (cid, path) for in-flight downloads, and
	// -> (cid, path, data) for in-flight uploads. tsclientlib resolves the
	// ftinitdownload/ftinitupload reply into a ready TCP stream on its own
	// (StreamItem::FileDownload/FileUpload below); these just remember which
	// request that stream belongs to.
	let mut pending_downloads: HashMap<u16, (u64, String)> = HashMap::new();
	let mut pending_uploads: HashMap<u16, (u64, String, Vec<u8>)> = HashMap::new();
	// Chunked uploads still arriving from the browser: (cid, path) -> (total size, bytes so far).
	let mut partial_uploads: HashMap<(u64, String), (u64, Vec<u8>)> = HashMap::new();
	// Set by "permissionlist" while waiting to emit the full permission
	// catalog (name-resolution reuses the same permission_names cache/fetch
	// as "permoverview" above).
	let mut pending_permission_catalog = false;
	// Set by "permlist <scope> ..." while one server-group/channel-group/
	// channel/client/channel+client permission listing is in flight - single
	// request at a time, matching the editor UI only ever loading one
	// selected target. (scope, id1, id2) echoes what was requested so the
	// eventual emit can be routed back to it.
	let mut pending_perm_list: Option<(String, u64, Option<u64>)> = None;
	let mut pending_perm_list_raw: Option<Vec<(u32, i32, bool, bool)>> = None;
	// TeaSpeak may reveal hidden channels after a group/permission change. Debounce
	// a channelsubscribeall so we pick up any channels the server only exposes then.
	let mut resubscribe_at: Option<tokio::time::Instant> = None;
	let mut ts_reconnecting = false;

	enum LoopOutcome {
		StdinLine(std::io::Result<Option<String>>),
		ConEvent(Option<Result<StreamItem, tsclientlib::Error>>),
		AudioTick,
		Resubscribe,
		ServerVarsRefresh,
	}

	// Keep virtualserver_maxclients / clientsonline in sync (GTS-style).
	let mut server_vars_ticker = tokio::time::interval(tokio::time::Duration::from_secs(20));
	server_vars_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
	// First tick fires immediately; we already requested once after connect.
	server_vars_ticker.tick().await;

	loop {
		let mut events = con.events();
		let outcome = tokio::select! {
			// After a stall (e.g. CPU steal) the missed audio ticks fire in a burst.
			// Polling in order drains the queued packets first, otherwise a tick can
			// find an empty queue and play Opus loss concealment instead.
			biased;
			line = stdin_lines.next_line() => LoopOutcome::StdinLine(line),
			ev = events.next() => LoopOutcome::ConEvent(ev),
			_ = audio_ticker.tick() => LoopOutcome::AudioTick,
			_ = server_vars_ticker.tick() => LoopOutcome::ServerVarsRefresh,
			_ = async {
				match resubscribe_at {
					Some(at) => tokio::time::sleep_until(at).await,
					None => std::future::pending::<()>().await,
				}
			} => LoopOutcome::Resubscribe,
		};
		drop(events);

		match outcome {
			LoopOutcome::StdinLine(line) => match line {
				Ok(Some(l)) => {
					let l = l.trim();
					if l == "disconnect" || l.starts_with("disconnect ") {
						let message = l.strip_prefix("disconnect").unwrap_or("").trim();
						let options = if message.is_empty() {
							DisconnectOptions::new()
						} else {
							DisconnectOptions::new().reason(Reason::Clientdisconnect).message(message)
						};
						con.disconnect(options)?;
						con.events().for_each(|_| future::ready(())).await;
						emit(&Event::Disconnected { reason: "client requested".into() });
						break;
					} else if let Some(rest) = l.strip_prefix("switch ") {
						// "switch <id>" or "switch <id> <base64-encoded password>" - the
						// password travels base64-encoded since this is a line-based
						// stdin protocol and a password could contain spaces/newlines.
						let mut switch_args = rest.trim().splitn(2, ' ');
						let id_arg = switch_args.next().unwrap_or("");
						let password_arg = switch_args.next();
						match id_arg.parse::<u64>() {
							Ok(id) => {
								let password = password_arg.and_then(|p| {
									base64::engine::general_purpose::STANDARD
										.decode(p)
										.ok()
										.and_then(|bytes| String::from_utf8(bytes).ok())
								});
								// Build clientmove defensively: missing own client must not panic
								// the whole connector (that looked like a dead Join from the UI).
								let part = match con.get_state() {
									Ok(state) => match state.clients.get(&state.own_client) {
										Some(own) => {
											let mut part = own.client_move(ChannelId(id));
											match &password {
												Some(pwd) => {
													part = part.set_password(pwd);
												}
												None => {
													// Always include cpw= (empty) like the GTS desktop client -
													// some TeaSpeak builds are picky about an omitted key.
													part.channel_password =
														Some(std::borrow::Cow::Borrowed(""));
												}
											}
											Some(part)
										}
										None => {
											emit(&Event::Error {
												message: "Channel switch failed: own client not in book state"
													.into(),
											});
											None
										}
									},
									Err(e) => {
										emit(&Event::Error {
											message: format!("Channel switch failed: {e}"),
										});
										None
									}
								};
								if let Some(part) = part {
									match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Channel switch".into());
											pending_switch_channel.insert(handle, id);
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									}
								}
									}
							Err(_) => emit(&Event::Error { message: format!("Invalid channel id: {id_arg}") }),
						}
					} else if let Some(message) = l.strip_prefix("chat ") {
						let part = OutSendTextMessagePart {
							target: TextMessageTargetMode::Channel,
							target_client_id: None,
							message: Cow::Borrowed(message),
						};
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_messages.insert(handle, "Channel message".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
						// No local echo here: the server reflects our own channel
						// messages back to us too, so it arrives via the normal
						// BookEvents/Event::Message path like anyone else's.
					} else if let Some(message) = l.strip_prefix("serverchat ") {
						let part = OutSendTextMessagePart {
							target: TextMessageTargetMode::Server,
							target_client_id: None,
							message: Cow::Borrowed(message),
						};
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_messages.insert(handle, "Server message".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
						// Same as channel chat: the server echoes this back to us too.
					} else if let Some(rest) = l.strip_prefix("pm ") {
						match rest.trim().split_once(' ') {
							Some((id, message)) => match id.parse::<u16>() {
								Ok(id) => {
									let part = OutSendTextMessagePart {
										target: TextMessageTargetMode::Client,
										target_client_id: Some(ClientId(id)),
										message: Cow::Borrowed(message),
									};
									match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Private message".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									}
									// Same as channel chat: the server echoes this back to
									// us via BookEvents/Event::Message, no local echo needed.
								}
								Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id}") }),
							},
							None => emit(&Event::Error { message: "Malformed pm command".into() }),
						}
					} else if let Some(rest) = l.strip_prefix("poke ") {
						// Unlike chat, a poke's message is optional - a plain poke with no
						// text is a normal thing to send in TeamSpeak.
						let rest = rest.trim();
						let (id, message) = rest.split_once(' ').unwrap_or((rest, ""));
						match id.parse::<u16>() {
							Ok(id) => {
								let part =
									OutClientPokeRequestPart { client_id: ClientId(id), message: Cow::Borrowed(message) };
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Poke".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id}") }),
						}
					} else if let Some(rest) = l.strip_prefix("moveclient ") {
						// Move another client (or self) into a channel: clientmove clid=… cid=…
						// Optional trailing base64 password, same as `switch`.
						let mut move_args = rest.trim().splitn(3, ' ');
						let clid_arg = move_args.next().unwrap_or("");
						let cid_arg = move_args.next().unwrap_or("");
						let password_arg = move_args.next();
						match (clid_arg.parse::<u16>(), cid_arg.parse::<u64>()) {
							(Ok(clid), Ok(cid)) => {
								let password = password_arg.and_then(|p| {
									base64::engine::general_purpose::STANDARD
										.decode(p)
										.ok()
										.and_then(|bytes| String::from_utf8(bytes).ok())
								});
								let part = match con.get_state() {
									Ok(state) => match state.clients.get(&ClientId(clid)) {
										Some(client) => {
											let mut part = client.client_move(ChannelId(cid));
											match &password {
												Some(pwd) => {
													part = part.set_password(pwd);
												}
												None => {
													part.channel_password =
														Some(std::borrow::Cow::Borrowed(""));
												}
											}
											Some(part)
										}
										None => {
											// Still try with raw ids if the client left our view.
											// Carry through the already-decoded password instead of
											// dropping it - this path is also used for self-moves
											// via drag-and-drop, which still need the password to
											// reach the server when the target channel requires one.
											Some(OutClientMovePart {
												client_id: ClientId(clid),
												channel_id: ChannelId(cid),
												channel_password: Some(match &password {
													Some(pwd) => Cow::Owned(pwd.clone()),
													None => Cow::Borrowed(""),
												}),
											})
										}
									},
									Err(e) => {
										emit(&Event::Error {
											message: format!("Move client failed: {e}"),
										});
										None
									}
								};
								if let Some(part) = part {
									match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Move client".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									}
								}
							}
							_ => emit(&Event::Error {
								message: format!("Malformed moveclient command: {rest}"),
							}),
						}
					} else if l == "away" || l.starts_with("away ") {
						let message = l.strip_prefix("away").unwrap_or("").trim();
						let part = con.get_state()?.client_update().set_away(Some(message));
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if l == "unaway" {
						let part = con.get_state()?.client_update().set_away(None);
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("muteinput ") {
						let part = con.get_state()?.client_update().set_input_muted(rest.trim() == "1");
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("muteoutput ") {
						let part = con.get_state()?.client_update().set_output_muted(rest.trim() == "1");
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("clientvolume ") {
						// `clientvolume <clid> <factor>`, 1 = unchanged, 0 = silent.
						let mut parts = rest.split_whitespace();
						match (
							parts.next().and_then(|v| v.parse::<u16>().ok()),
							parts.next().and_then(|v| v.parse::<f32>().ok()).filter(|v| v.is_finite()),
						) {
							(Some(clid), Some(volume)) => {
								let volume = volume.clamp(0.0, 2.0);
								if volume == 1.0 {
									client_volumes.remove(&clid);
								} else {
									client_volumes.insert(clid, volume);
								}
								if let Some(queue) = audio_handler.get_mut_queues().get_mut(&ClientId(clid)) {
									queue.volume = volume;
								}
							}
							_ => emit(&Event::Error {
								message: format!("Malformed clientvolume command: {rest}"),
							}),
						}
					} else if let Some(rest) = l.strip_prefix("nickname ") {
						let part = con.get_state()?.client_update().set_name(rest.trim());
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("whisper ") {
						// Format: "whisper <channelId,channelId,...>;<clientId,clientId,...>"
						// (either side may be empty, e.g. "whisper 5;" or "whisper ;12,13").
						let mut parts = rest.splitn(2, ';');
						let channels_part = parts.next().unwrap_or("");
						let clients_part = parts.next().unwrap_or("");
						whisper_channels = channels_part.split(',').filter_map(|s| s.trim().parse().ok()).collect();
						whisper_clients = clients_part.split(',').filter_map(|s| s.trim().parse().ok()).collect();
					} else if let Some(rest) = l.strip_prefix("whisperpolicy ") {
						let (mode, ids) = rest.split_once(';').unwrap_or((rest, ""));
						whisper_block_default = mode.trim() == "block";
						whisper_exceptions = ids.split(',').filter_map(|s| s.trim().parse().ok()).collect();
					} else if let Some(rest) = l.strip_prefix("ftlimit ") {
						let mut it = rest.split_whitespace().map(|v| v.parse::<u64>().unwrap_or(0));
						FT_LIMIT_UP.store(it.next().unwrap_or(0), Ordering::Relaxed);
						FT_LIMIT_DOWN.store(it.next().unwrap_or(0), Ordering::Relaxed);
					} else if l == "unwhisper" {
						whisper_channels.clear();
						whisper_clients.clear();
					} else if let Some(rest) = l.strip_prefix("clientconninfo ") {
						match rest.trim().parse::<u16>() {
							Ok(id) => {
								let client_id = ClientId(id);
								let part = con.get_state()?.clients.get(&client_id).map(|c| c.connection_info());
								match part {
									// send_with_result (rather than send) so a missing-permission
									// rejection (e.g. viewing another client's connection info
									// without b_client_view_connection_info) surfaces as a visible
									// error instead of leaving the dialog stuck loading forever.
									Some(part) => match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_client_conninfo = Some(client_id);
											pending_messages.insert(handle, "Connection info".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									},
									None => {
										emit(&Event::Error { message: format!("Unknown client id: {id}") })
									}
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("kickchannel ") {
						let mut parts = rest.splitn(2, ' ');
						let id_str = parts.next().unwrap_or("");
						let reason = parts.next().unwrap_or("").trim();
						match id_str.trim().parse::<u16>() {
							Ok(id) => {
								let client_id = ClientId(id);
								let part = con.get_state()?.clients.get(&client_id).map(|c| {
									let kick = c.kick(Reason::KickChannel);
									if reason.is_empty() { kick } else { kick.set_reason_message(reason) }
								});
								match part {
									Some(part) => match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Kick from channel".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									},
									None => {
										emit(&Event::Error { message: format!("Unknown client id: {id}") })
									}
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("kickserver ") {
						let mut parts = rest.splitn(2, ' ');
						let id_str = parts.next().unwrap_or("");
						let reason = parts.next().unwrap_or("").trim();
						match id_str.trim().parse::<u16>() {
							Ok(id) => {
								let client_id = ClientId(id);
								let part = con.get_state()?.clients.get(&client_id).map(|c| {
									let kick = c.kick(Reason::KickServer);
									if reason.is_empty() { kick } else { kick.set_reason_message(reason) }
								});
								match part {
									Some(part) => match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Kick from server".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									},
									None => {
										emit(&Event::Error { message: format!("Unknown client id: {id}") })
									}
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("banclient ") {
						// Format: "banclient <id> <seconds> <reason...>" - seconds=0 means permanent.
						// No typed builder exists for banclient, so this is built as a raw command
						// (same approach used for the connection-info requests above).
						let mut parts = rest.splitn(3, ' ');
						let id_str = parts.next().unwrap_or("");
						let seconds_str = parts.next().unwrap_or("0");
						let reason = parts.next().unwrap_or("").trim();
						match id_str.trim().parse::<u16>() {
							Ok(id) => {
								let seconds: u64 = seconds_str.trim().parse().unwrap_or(0);
								let mut packet =
									OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "banclient");
								packet.write_arg("clid", &id);
								if seconds > 0 {
									packet.write_arg("time", &seconds);
								}
								if !reason.is_empty() {
									packet.write_arg("banreason", &reason);
								}
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Ban client".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("serveredit ") {
						match serde_json::from_str::<ServerEditPayload>(rest) {
							Ok(payload) => {
								let mut part = con.get_state()?.server.edit();
								if let Some(v) = &payload.name {
									part = part.set_name(v);
								}
								if let Some(v) = &payload.welcome_message {
									part = part.set_welcome_message(v);
								}
								if let Some(v) = &payload.password {
									part = part.set_password(if v.is_empty() { None } else { Some(v) });
								}
								if let Some(v) = payload.max_clients {
									part = part.set_max_clients(v);
								}
								if let Some(v) = &payload.hostmessage {
									part = part.set_hostmessage(v);
								}
								if let Some(mode) =
									payload.hostmessage_mode.as_deref().and_then(parse_host_message_mode)
								{
									part = part.set_hostmessage_mode(mode);
								}
								if let Some(v) = &payload.hostbanner_url {
									part = part.set_hostbanner_url(v);
								}
								if let Some(v) = &payload.hostbanner_gfx_url {
									part = part.set_hostbanner_gfx_url(v);
								}
								if let Some(secs) = payload.hostbanner_gfx_interval_secs {
									part = part.set_hostbanner_gfx_interval(time::Duration::seconds(secs));
								}
								if let Some(mode) =
									payload.hostbanner_mode.as_deref().and_then(parse_host_banner_mode)
								{
									part = part.set_hostbanner_mode(mode);
								}
								if let Some(v) = &payload.hostbutton_tooltip {
									part = part.set_hostbutton_tooltip(v);
								}
								if let Some(v) = &payload.hostbutton_url {
									part = part.set_hostbutton_url(v);
								}
								if let Some(v) = &payload.hostbutton_gfx_url {
									part = part.set_hostbutton_gfx_url(v);
								}
								if let Some(v) = &payload.nickname {
									part = part.set_nickname(v);
								}
								if let Some(v) = &payload.phonetic_name {
									part = part.set_phonetic_name(v);
								}
								if let Some(mode) =
									payload.codec_encryption_mode.as_deref().and_then(parse_codec_encryption_mode)
								{
									part = part.set_codec_encryption_mode(mode);
								}
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Server edit".into());
										// Refresh counters/maxclients after edit (notifyserveredited
										// may be partial on TeaSpeak; servergetvariables fills gaps).
										send_server_get_variables(&mut con);
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(e) => emit(&Event::Error { message: format!("Invalid server edit payload: {e}") }),
						}
					} else if l == "serverconninfo" {
						let part = con.get_state()?.server.connection_info();
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_server_conninfo = true;
								pending_messages.insert(handle, "Server connection info".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if l == "serverlog" {
						let part = con.get_state()?.server.log_view().set_lines(200);
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_server_log = true;
								pending_messages.insert(handle, "Server log".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if let Some(rest) = l.strip_prefix("streaminfo ") {
						// A late joiner only learns *that* someone streams, from
						// the client_is_streaming property; the stream id has to
						// be pulled per client with this.
						match rest.trim().parse::<u16>() {
							Ok(clid) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"requeststreaminfo",
								);
								packet.write_arg("clid", &clid);
								if let Err(e) = packet.send(&mut con) {
									emit(&Event::Error { message: format!("requeststreaminfo failed: {e}") });
								}
							}
							Err(_) => emit(&Event::Error {
								message: format!("Invalid client id: {rest}"),
							}),
						}
					} else if let Some(rest) = l.strip_prefix("streamsetup ") {
						// Announce a stream we publish. The id is assigned by the
						// server and comes back as notifystreamstarted.
						match serde_json::from_str::<StreamSetupPayload>(rest) {
							Ok(s) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"setupstream",
								);
								packet.write_arg("name", &s.name);
								packet.write_arg("type", &s.kind);
								packet.write_arg("bitrate", &s.bitrate);
								packet.write_arg("accessibility", &s.accessibility);
								packet.write_arg("mode", &s.mode);
								packet.write_arg("viewer_limit", &s.viewer_limit);
								packet.write_arg("audio", &u8::from(s.audio));
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Start stream".into());
									}
									Err(e) => emit(&Event::Error {
										message: format!("setupstream failed: {e}"),
									}),
								}
							}
							Err(e) => emit(&Event::Error {
								message: format!("Invalid streamsetup payload: {e}"),
							}),
						}
					} else if let Some(rest) = l.strip_prefix("streamrespond ") {
						// Accept or refuse a viewer. decision=1 carries our SDP offer,
						// which is the mirror of how TS6 answered us when we watched.
						match serde_json::from_str::<StreamRespondPayload>(rest) {
							Ok(s) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"respondjoinstreamrequest",
								);
								packet.write_arg("id", &s.id);
								packet.write_arg("clid", &s.clid);
								packet.write_arg("msg", &s.msg);
								packet.write_arg("offer", &s.offer);
								packet.write_arg("decision", &s.decision);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Stream join response".into());
									}
									Err(e) => emit(&Event::Error {
										message: format!("respondjoinstreamrequest failed: {e}"),
									}),
								}
							}
							Err(e) => emit(&Event::Error {
								message: format!("Invalid streamrespond payload: {e}"),
							}),
						}
					} else if let Some(rest) = l.strip_prefix("streamstop ") {
						// "streamstop <stream-id> [reason]"
						let mut parts = rest.splitn(2, ' ');
						match parts.next() {
							Some(id) if !id.is_empty() => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"stopstream",
								);
								packet.write_arg("id", &id);
								packet.write_arg("reason", &parts.next().unwrap_or(""));
								if let Err(e) = packet.send(&mut con) {
									emit(&Event::Error { message: format!("stopstream failed: {e}") });
								}
							}
							_ => emit(&Event::Error {
								message: "Usage: streamstop <stream-id> [reason]".into(),
							}),
						}
					} else if let Some(rest) = l.strip_prefix("streamjoin ") {
						// "streamjoin <stream-id> <clid> [msg]" - ask the client
						// publishing a TS6 stream to let us in. Its reply is a
						// notifyrespondjoinstreamrequest carrying the SDP offer.
						send_join_stream_request(&mut con, rest, false);
					} else if let Some(rest) = l.strip_prefix("streamleave ") {
						// Same command with is_remove=1, which is how TS6 leaves
						// a stream it has joined.
						send_join_stream_request(&mut con, rest, true);
					} else if let Some(rest) = l.strip_prefix("streamsignal ") {
						// "streamsignal <stream-id> <clid> <json>" - the json is
						// the rest of the line, opaque to us. Escaping is done by
						// write_arg.
						let mut parts = rest.splitn(3, ' ');
						match (parts.next(), parts.next().and_then(|c| c.parse::<u16>().ok()), parts.next()) {
							(Some(id), Some(clid), Some(json)) if !id.is_empty() && !json.is_empty() => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"streamsignaling",
								);
								packet.write_arg("id", &id);
								packet.write_arg("clid", &clid);
								packet.write_arg("json", &json);
								// Not fire-and-forget: a signaling command the server refuses
								// (a stale clid, say) is otherwise indistinguishable from a peer
								// that simply ignored the payload, and the whole handshake then
								// stalls with nothing to look at.
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Stream signaling".into());
									}
									Err(e) => emit(&Event::Error {
										message: format!("streamsignaling failed: {e}"),
									}),
								}
							}
							_ => emit(&Event::Error {
								message: "Usage: streamsignal <stream-id> <clid> <json>".into(),
							}),
						}
					} else if l == "banlist" {
						// No typed builder exists for banlist, so this is built as a raw
						// command; the reply arrives via StreamItem::MessageEvent (see below).
						let packet = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "banlist");
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_ban_list = true;
								pending_messages.insert(handle, "Ban list".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if let Some(rest) = l.strip_prefix("bandel ") {
						match rest.trim().parse::<u32>() {
							Ok(ban_id) => {
								let mut packet =
									OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "bandel");
								packet.write_arg("banid", &ban_id);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Delete ban".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid ban id: {rest}") }),
						}
					} else if l == "bandelall" {
						let packet = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "bandelall");
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_messages.insert(handle, "Delete all bans".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if l == "complainlist" {
						let packet =
							OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "complainlist");
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_complain_list = true;
								pending_messages.insert(handle, "Complain list".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if let Some(rest) = l.strip_prefix("complaindel ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let target_str = parts.next().unwrap_or("");
						let from_str = parts.next().unwrap_or("");
						match (target_str.parse::<u64>(), from_str.parse::<u64>()) {
							(Ok(tcldbid), Ok(fcldbid)) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"complaindel",
								);
								packet.write_arg("tcldbid", &tcldbid);
								packet.write_arg("fcldbid", &fcldbid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Delete complaint".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							_ => emit(&Event::Error { message: format!("Invalid complaindel args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("complaindelall ") {
						match rest.trim().parse::<u64>() {
							Ok(tcldbid) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"complaindelall",
								);
								packet.write_arg("tcldbid", &tcldbid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Delete all complaints for client".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client db id: {rest}") }),
						}
					} else if l == "messagelist" {
						let packet =
							OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "messagelist");
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_offline_message_list = true;
								pending_messages.insert(handle, "Offline message list".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if let Some(rest) = l.strip_prefix("messageget ") {
						match rest.trim().parse::<u32>() {
							Ok(msgid) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"messageget",
								);
								packet.write_arg("msgid", &msgid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_offline_message_get = true;
										pending_messages.insert(handle, "Offline message".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid message id: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("messageadd ") {
						let mut parts = rest.splitn(3, '\t');
						let cluid = parts.next().unwrap_or("");
						let subject = parts.next().unwrap_or("");
						let message = parts.next().unwrap_or("");
						let mut packet =
							OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "messageadd");
						packet.write_arg("cluid", &cluid);
						packet.write_arg("subject", &subject);
						packet.write_arg("message", &message);
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_messages.insert(handle, "Send offline message".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if let Some(rest) = l.strip_prefix("messagedel ") {
						match rest.trim().parse::<u32>() {
							Ok(msgid) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"messagedel",
								);
								packet.write_arg("msgid", &msgid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Delete offline message".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid message id: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("messageupdateflag ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let msgid_str = parts.next().unwrap_or("");
						let flag_str = parts.next().unwrap_or("");
						match msgid_str.parse::<u32>() {
							Ok(msgid) => {
								let flag = flag_str.trim() == "1";
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"messageupdateflag",
								);
								packet.write_arg("msgid", &msgid);
								packet.write_arg("flag", &flag);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Mark offline message read".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid message id: {rest}") }),
						}
					} else if l == "channelgrouplist" {
						let packet = OutCommand::new(
							Direction::C2S,
							Flags::empty(),
							PacketType::Command,
							"channelgrouplist",
						);
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_channel_group_list = true;
								pending_messages.insert(handle, "Channel group list".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if l == "servergrouplist" {
						let packet = OutCommand::new(
							Direction::C2S,
							Flags::empty(),
							PacketType::Command,
							"servergrouplist",
						);
						match packet.send_with_result(&mut con) {
							Ok(handle) => {
								pending_server_group_list = true;
								pending_messages.insert(handle, "Server group list".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if let Some(rest) = l.strip_prefix("setchannelgroup ") {
						let mut parts = rest.trim().splitn(3, ' ');
						let cgid_str = parts.next().unwrap_or("");
						let cid_str = parts.next().unwrap_or("");
						let cldbid_str = parts.next().unwrap_or("");
						match (cgid_str.parse::<u64>(), cid_str.parse::<u64>(), cldbid_str.parse::<u64>()) {
							(Ok(cgid), Ok(cid), Ok(cldbid)) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"setclientchannelgroup",
								);
								packet.write_arg("cgid", &cgid);
								packet.write_arg("cid", &cid);
								packet.write_arg("cldbid", &cldbid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Assign channel group".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							_ => emit(&Event::Error { message: format!("Invalid setchannelgroup args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("addservergroup ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let sgid_str = parts.next().unwrap_or("");
						let cldbid_str = parts.next().unwrap_or("");
						match (sgid_str.parse::<u64>(), cldbid_str.parse::<u64>()) {
							(Ok(sgid), Ok(cldbid)) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"servergroupaddclient",
								);
								packet.write_arg("sgid", &sgid);
								packet.write_arg("cldbid", &cldbid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Assign server group".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							_ => emit(&Event::Error { message: format!("Invalid addservergroup args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("delservergroup ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let sgid_str = parts.next().unwrap_or("");
						let cldbid_str = parts.next().unwrap_or("");
						match (sgid_str.parse::<u64>(), cldbid_str.parse::<u64>()) {
							(Ok(sgid), Ok(cldbid)) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"servergroupdelclient",
								);
								packet.write_arg("sgid", &sgid);
								packet.write_arg("cldbid", &cldbid);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Remove server group".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							_ => emit(&Event::Error { message: format!("Invalid delservergroup args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("serverquerylogin ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let user_b64 = parts.next().unwrap_or("");
						let pass_b64 = parts.next().unwrap_or("");
						let decoded = base64::engine::general_purpose::STANDARD
							.decode(user_b64)
							.ok()
							.and_then(|b| String::from_utf8(b).ok())
							.zip(
								base64::engine::general_purpose::STANDARD
									.decode(pass_b64)
									.ok()
									.and_then(|b| String::from_utf8(b).ok()),
							);
						match decoded {
							Some((username, password)) => {
								let mut packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"login",
								);
								packet.write_arg("client_login_name", &username);
								packet.write_arg("client_login_password", &password);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "ServerQuery Login".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							None => emit(&Event::Error { message: "Invalid serverquerylogin args".into() }),
						}
					} else if l == "permoverview" {
						let state = con.get_state()?;
						let own_id = state.own_client;
						if let Some(own) = state.clients.get(&own_id) {
							let cid = own.channel.0;
							let cldbid = own.database_id.0;
							if permission_names.is_empty() && !pending_permission_list {
								let packet = OutCommand::new(
									Direction::C2S,
									Flags::empty(),
									PacketType::Command,
									"permissionlist",
								);
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_permission_list = true;
										pending_messages.insert(handle, "Permission list".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							let mut packet = OutCommand::new(
								Direction::C2S,
								Flags::empty(),
								PacketType::Command,
								"permoverview",
							);
							packet.write_arg("cid", &cid);
							packet.write_arg("cldbid", &cldbid);
							// permid=0 means "all permissions" - the server requires this
							// argument even though tsclientlib's generated type treats it
							// as optional.
							packet.write_arg("permid", &0u32);
							match packet.send_with_result(&mut con) {
								Ok(handle) => {
									pending_perm_overview = true;
									pending_messages.insert(handle, "Permission overview".into());
								}
								Err(e) => emit(&Event::Error { message: e.to_string() }),
							}
						}
					} else if let Some(rest) = l.strip_prefix("ftlist ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let cid_str = parts.next().unwrap_or("");
						let path = parts.next().unwrap_or("/").trim();
						let path = if path.is_empty() { "/" } else { path };
						match cid_str.parse::<u64>() {
							Ok(cid) => {
								let part = OutFileListRequestPart {
									channel_id: ChannelId(cid),
									channel_password: Cow::Borrowed(""),
									path: Cow::Borrowed(path),
								};
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_file_list = Some((cid, path.to_string()));
										file_list_buffer.clear();
										pending_messages.insert(handle, "File list".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid channel id: {cid_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("ftmkdir ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let cid_str = parts.next().unwrap_or("");
						let dirname = parts.next().unwrap_or("").trim();
						match cid_str.parse::<u64>() {
							Ok(cid) => {
								let part = OutCreateDirectoryPart {
									channel_id: ChannelId(cid),
									channel_password: Cow::Borrowed(""),
									directory_name: Cow::Borrowed(dirname),
								};
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Create directory".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid channel id: {cid_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("ftdelete ") {
						let mut parts = rest.trim().splitn(2, ' ');
						let cid_str = parts.next().unwrap_or("");
						let name = parts.next().unwrap_or("").trim();
						match cid_str.parse::<u64>() {
							Ok(cid) => {
								let part = OutDeleteFilePart {
									channel_id: ChannelId(cid),
									channel_password: Cow::Borrowed(""),
									name: Cow::Borrowed(name),
								};
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Delete file".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid channel id: {cid_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("ftrename ") {
						let mut parts = rest.splitn(3, '\t');
						let cid_str = parts.next().unwrap_or("");
						let old_name = parts.next().unwrap_or("");
						let new_name = parts.next().unwrap_or("");
						match cid_str.trim().parse::<u64>() {
							Ok(cid) => {
								let part = OutRenameFilePart {
									channel_id: ChannelId(cid),
									channel_password: Cow::Borrowed(""),
									target_channel_id: None,
									target_channel_password: None,
									old_name: Cow::Borrowed(old_name),
									new_name: Cow::Borrowed(new_name),
								};
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Rename file".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid ftrename args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("ftdownload ") {
						// Download uses tsclientlib's own `download_file`/StreamItem::FileDownload
						// machinery rather than a raw OutCommand: it already handles the whole
						// "ftinitdownload, then connect+auth the returned TCP data port" dance
						// for us (see StreamItem::FileDownload handling below).
						let mut parts = rest.trim().splitn(2, ' ');
						let cid_str = parts.next().unwrap_or("");
						let path = parts.next().unwrap_or("").trim();
						match cid_str.parse::<u64>() {
							Ok(cid) => match con.download_file(ChannelId(cid), path, None, None) {
								Ok(handle) => {
									pending_downloads.insert(handle.0, (cid, path.to_string()));
								}
								Err(e) => emit(&Event::TransferError {
									message: format!("Download failed: {e}"),
									cid,
									path: path.to_string(),
								}),
							},
							Err(_) => emit(&Event::Error { message: format!("Invalid channel id: {cid_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("ftupload ") {
						let mut parts = rest.splitn(3, '\t');
						let cid_str = parts.next().unwrap_or("");
						let path = parts.next().unwrap_or("");
						let data_b64 = parts.next().unwrap_or("");
						match (
							cid_str.trim().parse::<u64>(),
							base64::engine::general_purpose::STANDARD.decode(data_b64.trim()),
						) {
							(Ok(cid), Ok(bytes)) => {
								let size = bytes.len() as u64;
								match con.upload_file(ChannelId(cid), path, None, size, true, false) {
									Ok(handle) => {
										pending_uploads.insert(handle.0, (cid, path.to_string(), bytes));
									}
									Err(e) => emit(&Event::TransferError {
										message: format!("Upload failed: {e}"),
										cid,
										path: path.to_string(),
									}),
								}
							}
							_ => emit(&Event::Error { message: "Invalid ftupload args".into() }),
						}
					} else if let Some(rest) = l.strip_prefix("ftuploadchunk ") {
						match take_upload_chunk(&mut partial_uploads, rest) {
							Ok(Some((cid, path, bytes))) => {
								match con.upload_file(ChannelId(cid), &path, None, bytes.len() as u64, true, false) {
									Ok(handle) => {
										pending_uploads.insert(handle.0, (cid, path, bytes));
									}
									Err(e) => emit(&Event::TransferError { message: format!("Upload failed: {e}"), cid, path }),
								}
							}
							Ok(None) => {}
							Err(message) => {
								// Same field order as take_upload_chunk: cid, offset, total, path, data.
								let fields: Vec<&str> = rest.splitn(5, '\t').collect();
								match (fields[0].trim().parse::<u64>(), fields.get(3)) {
									(Ok(cid), Some(path)) => {
										emit(&Event::TransferError { message, cid, path: path.to_string() })
									}
									_ => emit(&Event::Error { message }),
								}
							}
						}
					} else if l == "permissionlist" {
						if pending_permission_list {
							// A catalog fetch is already in flight (triggered by an
							// earlier permlist/permoverview request racing with this
							// one) - piggyback on it instead of firing a duplicate
							// "permissionlist" command, which would interleave two
							// independent chunk streams into the same ordinal counter
							// and corrupt the id->name mapping.
							pending_permission_catalog = true;
						} else if permission_names.is_empty() {
							let packet = OutCommand::new(
								Direction::C2S,
								Flags::empty(),
								PacketType::Command,
								"permissionlist",
							);
							match packet.send_with_result(&mut con) {
								Ok(handle) => {
									pending_permission_list = true;
									pending_permission_catalog = true;
									pending_messages.insert(handle, "Permission list".into());
								}
								Err(e) => emit(&Event::Error { message: e.to_string() }),
							}
						} else {
							let entries: Vec<PermissionCatalogEntry> = permission_names
								.iter()
								.map(|(id, (name, description))| PermissionCatalogEntry {
									id: *id,
									name: name.clone(),
									description: description.clone(),
								})
								.collect();
							emit(&Event::PermissionCatalog { entries });
						}
					} else if let Some(rest) = l.strip_prefix("permlist ") {
						let parts: Vec<&str> = rest.trim().split_whitespace().collect();
						let target = match parts.as_slice() {
							["server", sgid] => sgid.parse::<u64>().ok().map(|id| {
								("server".to_string(), id, None, OutServerGroupPermListRequestPart {
									server_group_id: ServerGroupId(id),
								}.to_packet())
							}),
							["channelgroup", cgid] => cgid.parse::<u64>().ok().map(|id| {
								("channelgroup".to_string(), id, None, OutChannelGroupPermListRequestPart {
									channel_group: ChannelGroupId(id),
								}.to_packet())
							}),
							["channel", cid] => cid.parse::<u64>().ok().map(|id| {
								("channel".to_string(), id, None, OutChannelPermListRequestPart { channel_id: ChannelId(id) }.to_packet())
							}),
							["client", cldbid] => cldbid.parse::<u64>().ok().map(|id| {
								("client".to_string(), id, None, OutClientPermListRequestPart { client_db_id: ClientDbId(id) }.to_packet())
							}),
							["channelclient", cid, cldbid] => match (cid.parse::<u64>(), cldbid.parse::<u64>()) {
								(Ok(id1), Ok(id2)) => Some((
									"channelclient".to_string(),
									id1,
									Some(id2),
									OutChannelClientPermListRequestPart {
										channel_id: ChannelId(id1),
										client_db_id: ClientDbId(id2),
									}
									.to_packet(),
								)),
								_ => None,
							},
							_ => None,
						};
						match target {
							Some((scope, id1, id2, packet)) => {
								if permission_names.is_empty() && !pending_permission_list {
									let names_packet = OutCommand::new(
										Direction::C2S,
										Flags::empty(),
										PacketType::Command,
										"permissionlist",
									);
									match names_packet.send_with_result(&mut con) {
										Ok(handle) => {
											pending_permission_list = true;
											pending_messages.insert(handle, "Permission list".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									}
								}
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_perm_list = Some((scope, id1, id2));
										pending_messages.insert(handle, "Permission list request".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							None => emit(&Event::Error { message: format!("Invalid permlist args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("permadd ") {
						let parts: Vec<&str> = rest.trim().split_whitespace().collect();
						let result = (|| -> Option<OutCommand> {
							match parts.as_slice() {
								["server", sgid, permid, value, negated, skip] => Some(
									OutServerGroupAddPermPart {
										server_group_id: ServerGroupId(sgid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
										permission_value: value.parse().ok()?,
										permission_negated: *negated == "1",
										permission_skip: *skip == "1",
									}
									.to_packet(),
								),
								["channelgroup", cgid, permid, value] => Some(
									OutChannelGroupAddPermPart {
										channel_group: ChannelGroupId(cgid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
										permission_value: value.parse().ok()?,
									}
									.to_packet(),
								),
								["channel", cid, permid, value] => Some(
									OutChannelAddPermPart {
										channel_id: ChannelId(cid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
										permission_value: value.parse().ok()?,
									}
									.to_packet(),
								),
								["client", cldbid, permid, value, skip] => Some(
									OutClientAddPermPart {
										client_db_id: ClientDbId(cldbid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
										permission_value: value.parse().ok()?,
										permission_skip: *skip == "1",
									}
									.to_packet(),
								),
								["channelclient", cid, cldbid, permid, value] => Some(
									OutChannelClientAddPermPart {
										channel_id: ChannelId(cid.parse().ok()?),
										client_db_id: ClientDbId(cldbid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
										permission_value: value.parse().ok()?,
									}
									.to_packet(),
								),
								_ => None,
							}
						})();
						match result {
							Some(packet) => match packet.send_with_result(&mut con) {
								Ok(handle) => {
									pending_messages.insert(handle, "Add permission".into());
								}
								Err(e) => emit(&Event::Error { message: e.to_string() }),
							},
							None => emit(&Event::Error { message: format!("Invalid permadd args: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("permdel ") {
						let parts: Vec<&str> = rest.trim().split_whitespace().collect();
						let result = (|| -> Option<OutCommand> {
							match parts.as_slice() {
								["server", sgid, permid] => Some(
									OutServerGroupDelPermPart {
										server_group_id: ServerGroupId(sgid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
									}
									.to_packet(),
								),
								["channelgroup", cgid, permid] => Some(
									OutChannelGroupDelPermPart {
										channel_group: ChannelGroupId(cgid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
									}
									.to_packet(),
								),
								["channel", cid, permid] => Some(
									OutChannelDelPermPart {
										channel_id: ChannelId(cid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
									}
									.to_packet(),
								),
								["client", cldbid, permid] => Some(
									OutClientDelPermPart {
										client_db_id: ClientDbId(cldbid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
									}
									.to_packet(),
								),
								["channelclient", cid, cldbid, permid] => Some(
									OutChannelClientDelPermPart {
										channel_id: ChannelId(cid.parse().ok()?),
										client_db_id: ClientDbId(cldbid.parse().ok()?),
										permission_id: Some(Permission(permid.parse().ok()?)),
										permission_name_id: None,
									}
									.to_packet(),
								),
								_ => None,
							}
						})();
						match result {
							Some(packet) => match packet.send_with_result(&mut con) {
								Ok(handle) => {
									pending_messages.insert(handle, "Remove permission".into());
								}
								Err(e) => emit(&Event::Error { message: e.to_string() }),
							},
							None => emit(&Event::Error { message: format!("Invalid permdel args: {rest}") }),
						}
					} else if let Some(b64) = l.strip_prefix("audio ") {
						match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
							Ok(bytes) => {
								let samples: Vec<f32> = bytes
									.chunks_exact(2)
									.map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
									.collect();
								if samples.len() == FRAME_SAMPLES {
									let mut opus_output = [0u8; 1275];
									match opus_encoder.encode_float(&samples, &mut opus_output) {
										Ok(len) => {
											let has_whisper_targets =
												!whisper_channels.is_empty() || !whisper_clients.is_empty();
											let packet = if has_whisper_targets {
												OutAudio::new(&AudioData::C2SWhisper {
													id: 0,
													codec: CodecType::OpusVoice,
													channels: whisper_channels.clone(),
													clients: whisper_clients.clone(),
													data: &opus_output[..len],
												})
											} else {
												OutAudio::new(&AudioData::C2S {
													id: 0,
													codec: CodecType::OpusVoice,
													data: &opus_output[..len],
												})
											};
											if let Err(e) = con.send_audio(packet) {
												emit(&Event::Error { message: e.to_string() });
											}
										}
										Err(e) => emit(&Event::Error { message: format!("Opus encode failed: {e}") }),
									}
								}
							}
							Err(e) => emit(&Event::Error { message: format!("Invalid audio payload: {e}") }),
						}
					}
					// unrecognized lines are ignored
				}
				Ok(None) => {
					emit(&Event::Disconnected { reason: "stdin closed".into() });
					break;
				}
				Err(e) => {
					emit(&Event::Error { message: e.to_string() });
					break;
				}
			},
			LoopOutcome::ConEvent(ev) => match ev {
				Some(Ok(StreamItem::BookEvents(events))) => {
					if ts_reconnecting {
						// The new session starts unsubscribed, which would leave
						// everyone but us invisible.
						ts_reconnecting = false;
						resubscribe_at = Some(tokio::time::Instant::now());
						emit(&Event::Reconnected);
					}
					let own_id = con.get_state()?.own_client;
					for event in &events {
						if let BookEvent::Message { target, invoker, message } = event {
							match target {
								MessageTarget::Server => {
									emit(&Event::ServerMessage {
										from: invoker.name.clone(),
										message: message.clone(),
									});
								}
								MessageTarget::Channel => {
									emit(&Event::ChatMessage {
										from: invoker.name.clone(),
										message: message.clone(),
									});
								}
								MessageTarget::Client(other_id) => {
									if invoker.id == own_id {
										let partner_name = con
											.get_state()?
											.clients
											.get(other_id)
											.map(|c| c.name.clone())
											.unwrap_or_default();
										emit(&Event::PrivateMessage {
											partner_id: other_id.0,
											partner_name,
											from_self: true,
											message: message.clone(),
										});
									} else {
										emit(&Event::PrivateMessage {
											partner_id: invoker.id.0,
											partner_name: invoker.name.clone(),
											from_self: false,
											message: message.clone(),
										});
									}
								}
								MessageTarget::Poke(_) => {
									emit(&Event::Poke { from: invoker.name.clone(), message: message.clone() });
								}
							}
						} else {
							// Group add/remove emit PropertyAdded/Removed (not Changed).
							if matches!(
								event,
								BookEvent::PropertyAdded {
									id: PropertyId::ClientServerGroup(id, _),
									..
								} | BookEvent::PropertyRemoved {
									id: PropertyId::ClientServerGroup(id, _),
									..
								} if *id == own_id
							) {
								resubscribe_at = Some(
									tokio::time::Instant::now()
										+ tokio::time::Duration::from_millis(250),
								);
							}
							log_book_event(con.get_state()?, event);
						}
					}
					if let Some(client_id) = pending_client_conninfo {
						match con.get_state()?.clients.get(&client_id) {
							Some(client) => {
								if let Some(data) = &client.connection_data {
									emit(&Event::ClientConnectionInfo {
										client_id: client_id.0,
										ping_ms: data.ping.map(|d| d.as_seconds_f64() * 1000.0),
										connected_secs: data.connected_time.map(|d| d.whole_seconds()),
										ip: data.client_address.map(|a| a.ip().to_string()),
										packets_sent: data.packets_sent_speech.unwrap_or(0)
											+ data.packets_sent_keepalive.unwrap_or(0)
											+ data.packets_sent_control.unwrap_or(0),
										bytes_sent: data.bytes_sent_speech.unwrap_or(0)
											+ data.bytes_sent_keepalive.unwrap_or(0)
											+ data.bytes_sent_control.unwrap_or(0),
										packets_received: data.packets_received_speech.unwrap_or(0)
											+ data.packets_received_keepalive.unwrap_or(0)
											+ data.packets_received_control.unwrap_or(0),
										bytes_received: data.bytes_received_speech.unwrap_or(0)
											+ data.bytes_received_keepalive.unwrap_or(0)
											+ data.bytes_received_control.unwrap_or(0),
										packet_loss_percent: data.client_to_server_packetloss_total,
									});
									pending_client_conninfo = None;
								}
							}
							None => pending_client_conninfo = None,
						}
					}
					if pending_server_conninfo {
						let state = con.get_state()?;
						// GreenTeaSpeak reports packet loss already as a percent; classic
						// TeamSpeak3/TeaSpeak report it as a fraction (0-1). A value's magnitude
						// alone can't disambiguate a healthy GTS server (e.g. 0.5%) from a bad
						// TS3 one (e.g. 0.5 = 50%), so branch on the actual server type instead.
						let is_gts = is_greenteaspeak_server_version(&state.server.version);
						if let Some(data) = &state.server.connection_data {
							let loss = data.packetloss_total;
							let packet_loss_percent = if is_gts { loss } else { loss * 100.0 };
							emit(&Event::ServerConnectionInfo {
								ping_ms: data.ping.as_seconds_f64() * 1000.0,
								connected_secs: data.connected_time_total.whole_seconds(),
								packet_loss_percent,
								packets_sent_total: data.packets_sent_total,
								bytes_sent_total: data.bytes_sent_total,
								packets_received_total: data.packets_received_total,
								bytes_received_total: data.bytes_received_total,
								bandwidth_sent_last_second: data.bandwidth_sent_last_second_total,
								bandwidth_received_last_second: data.bandwidth_received_last_second_total,
								bandwidth_sent_last_minute: data.bandwidth_sent_last_minute_total,
								bandwidth_received_last_minute: data.bandwidth_received_last_minute_total,
								filetransfer_bandwidth_sent: data.filetransfer_bandwidth_sent,
								filetransfer_bandwidth_received: data.filetransfer_bandwidth_received,
								filetransfer_bytes_sent: data.filetransfer_bytes_sent_total,
								filetransfer_bytes_received: data.filetransfer_bytes_received_total,
							});
							pending_server_conninfo = false;
						}
					}
					emit(&snapshot(con.get_state()?));
				}
				Some(Ok(StreamItem::Audio(packet))) => {
					let (from, whisper) = match packet.data().data() {
						AudioData::S2C { from, .. } => (Some(ClientId(*from)), false),
						AudioData::S2CWhisper { from, .. } => (Some(ClientId(*from)), true),
						_ => (None, false),
					};
					// A whisper gets through when its sender isn't an exception to a
					// blocking mode, or is one to an allowing mode.
					let from =
						from.filter(|f| !whisper || whisper_block_default == whisper_exceptions.contains(&f.0));
					if let Some(from) = from {
						if let Ok(Some(new_talker)) = audio_handler.handle_packet(from, packet) {
							if let (Some(&volume), Some(queue)) = (
								client_volumes.get(&new_talker.0),
								audio_handler.get_mut_queues().get_mut(&new_talker),
							) {
								queue.volume = volume;
							}
							if talking.insert(new_talker.0) {
								emit(&Event::Talkers { clients: talking.iter().copied().collect() });
								if whisper {
									emit(&Event::WhisperReceived { client_id: new_talker.0 });
								}
							}
						}
					}
				}
				Some(Ok(StreamItem::MessageResult(handle, result))) => {
					if let Some(label) = pending_messages.remove(&handle) {
						let switch_channel_id = pending_switch_channel.remove(&handle);
						if let Err(e) = result {
							if label == "Channel switch" && e.error == TsError::ChannelInvalidPassword {
								if let Some(channel_id) = switch_channel_id {
									emit(&Event::ChannelPasswordRequired { channel_id });
								} else {
									emit(&Event::Error { message: format!("{label} failed: {e}") });
								}
							} else if e.missing_permission.is_some() {
								emit(&Event::ServerLog {
									entry: ServerLogEntry::PermissionError { action: label },
								});
							} else {
								emit(&Event::Error { message: format!("{label} failed: {e}") });
							}
							pending_channel_group_list = false;
							pending_server_group_list = false;
						} else if label == "Channel group list" && pending_channel_group_list {
							// The server never sends this back as a notifychannelgrouplist
							// reply we can match on InMessage - it arrives as book-state
							// PropertyAdded events instead, already applied to the connection by the
							// time this Ok(()) shows up, so read the groups straight out of
							// book state instead of waiting for a reply that never comes.
							let state = con.get_state()?;
							let mut entries: Vec<GroupEntry> = state
								.channel_groups
								.values()
								.map(|g| GroupEntry { id: g.id.0, name: g.name.clone(), icon_id: g.icon.0 })
								.collect();
							entries.sort_by_key(|g| g.id);
							emit(&Event::ChannelGroupList { entries });
							pending_channel_group_list = false;
						} else if label == "Server group list" && pending_server_group_list {
							let state = con.get_state()?;
							let mut entries: Vec<GroupEntry> = state
								.server_groups
								.values()
								.map(|g| GroupEntry { id: g.id.0, name: g.name.clone(), icon_id: g.icon.0 })
								.collect();
							entries.sort_by_key(|g| g.id);
							emit(&Event::ServerGroupList { entries });
							pending_server_group_list = false;
						} else if label == "Permission list" && pending_permission_list {
							pending_permission_list = false;
							if let Some(raw) = pending_perm_overview_raw.take() {
								let entries: Vec<PermissionOverviewEntry> = raw
									.into_iter()
									.map(|(id, value, negated, skip)| {
										let (name, description) = permission_names
											.get(&id)
											.cloned()
											.unwrap_or_else(|| (format!("#{id}"), String::new()));
										PermissionOverviewEntry { name, description, value, negated, skip }
									})
									.collect();
								emit(&Event::PermissionOverview { entries });
							}
							if let Some(raw) = pending_perm_list_raw.take() {
								if let Some((scope, id1, id2)) = pending_perm_list.take() {
									let entries: Vec<PermissionOverviewEntry> = raw
										.into_iter()
										.map(|(id, value, negated, skip)| {
											let (name, description) = permission_names
												.get(&id)
												.cloned()
												.unwrap_or_else(|| (format!("#{id}"), String::new()));
											PermissionOverviewEntry { name, description, value, negated, skip }
										})
										.collect();
									emit(&Event::PermList { scope, id1, id2, entries });
								}
							}
							if pending_permission_catalog {
								pending_permission_catalog = false;
								let entries: Vec<PermissionCatalogEntry> = permission_names
									.iter()
									.map(|(id, (name, description))| PermissionCatalogEntry {
										id: *id,
										name: name.clone(),
										description: description.clone(),
									})
									.collect();
								emit(&Event::PermissionCatalog { entries });
							}
						}
					}
				}
				Some(Ok(StreamItem::UnknownCommand { name, content })) => {
					// Undeclared commands are invisible everywhere else, so name
					// them on stderr - that is the only way to tell "the server
					// sent nothing" apart from "we filtered it out".
					eprintln!("[unknown-command] {name}");
					// TS6 Stream/Call signaling. Everything else undeclared is
					// dropped on purpose - forwarding every unknown command
					// would turn this into a firehose, and nothing downstream
					// wants it.
					// ends_with, not starts_with: the inbound request is
					// notifyjoinstreamrequest and the reply
					// notifyrespondjoinstreamrequest. Matching only the latter's
					// prefix silently dropped every viewer asking to watch *us*,
					// which is the whole publishing direction.
					if name.starts_with("notifystream") || name.ends_with("joinstreamrequest")
					{
						emit(&Event::StreamEvent { args: parse_ts_args(&content), name });
					}
				}
				Some(Ok(StreamItem::MessageEvent(msg))) => {
					// Defense in depth: TeaSpeak/GTS may surface notifyclientpoke as an
					// unhandled MessageEvent if bookkeeping did not mark it handled.
					if let InMessage::ClientPoke(poke) = &msg {
						for part in poke.iter() {
							emit(&Event::Poke {
								from: part.invoker_name.clone(),
								message: part.message.clone().unwrap_or_default(),
							});
						}
					} else if let InMessage::ClientPokeNormal(poke) = &msg {
						for part in poke.iter() {
							emit(&Event::Poke {
								from: part.invoker_name.clone(),
								message: part.message.clone().unwrap_or_default(),
							});
						}
					}
					if pending_server_log {
						if let InMessage::ServerLog(log) = &msg {
							let lines: Vec<String> = log.iter().map(|part| part.log.clone()).collect();
							emit(&Event::ServerProtocolLog { lines });
							pending_server_log = false;
						}
					}
					if pending_ban_list {
						if let InMessage::BanList(list) = &msg {
							let entries: Vec<BanListEntry> = list
								.iter()
								.map(|part| BanListEntry {
									ban_id: part.ban_id,
									ip: part.ip.to_string(),
									name: part.name.clone(),
									uid: part.uid.to_string(),
									last_nickname: part.last_nickname.clone(),
									created: part.created.to_string(),
									duration_secs: part.duration.whole_seconds(),
									invoker_name: part.invoker_name.clone(),
									reason: part.reason.clone(),
									enforcements: part.enforcements,
								})
								.collect();
							emit(&Event::BanList { entries });
							pending_ban_list = false;
						}
					}
					if pending_complain_list {
						if let InMessage::ComplainList(list) = &msg {
							let entries: Vec<ComplainListEntry> = list
								.iter()
								.map(|part| ComplainListEntry {
									target_client_db_id: part.target_client_db_id.0,
									target_name: part.target_name.clone(),
									from_client_db_id: part.from_client_db_id.0,
									from_name: part.from_name.clone(),
									message: part.message.clone(),
									timestamp: part.timestamp.to_string(),
								})
								.collect();
							emit(&Event::ComplainList { entries });
							pending_complain_list = false;
						}
					}
					if pending_offline_message_list {
						if let InMessage::OfflineMessageList(list) = &msg {
							let entries: Vec<OfflineMessageListEntry> = list
								.iter()
								.map(|part| OfflineMessageListEntry {
									message_id: part.message_id,
									client_uid: part.client_uid.to_string(),
									subject: part.subject.clone(),
									timestamp: part.timestamp.to_string(),
									is_read: part.is_read,
								})
								.collect();
							emit(&Event::OfflineMessageList { entries });
							pending_offline_message_list = false;
						}
					}
					if pending_offline_message_get {
						if let InMessage::OfflineMessage(list) = &msg {
							if let Some(part) = list.iter().next() {
								emit(&Event::OfflineMessage {
									message_id: part.message_id,
									client_uid: part.client_uid.to_string(),
									subject: part.subject.clone(),
									message: part.message.clone(),
									timestamp: part.timestamp.to_string(),
								});
							}
							pending_offline_message_get = false;
						}
					}
					if pending_channel_group_list {
						if let InMessage::ChannelGroupList(list) = &msg {
							let entries: Vec<GroupEntry> = list
								.iter()
								.map(|part| GroupEntry { id: part.channel_group.0, name: part.name.clone(), icon_id: part.icon.0 })
								.collect();
							emit(&Event::ChannelGroupList { entries });
							pending_channel_group_list = false;
						}
					}
					if pending_server_group_list {
						if let InMessage::ServerGroupList(list) = &msg {
							let entries: Vec<GroupEntry> = list
								.iter()
								.map(|part| GroupEntry { id: part.server_group_id.0, name: part.name.clone(), icon_id: part.icon.0 })
								.collect();
							emit(&Event::ServerGroupList { entries });
							pending_server_group_list = false;
						}
					}
					if pending_permission_list {
						// Just accumulate here - a full permissionlist reply on a real
						// account with hundreds of permissions arrives as several
						// separate notifypermissionlist events (unlike the tiny
						// marker-only reply a permission-limited guest gets, which
						// fits in one), so finalizing after the first one truncates
						// the name table. The actual end-of-command signal is the
						// MessageResult for this handle, handled below.
						//
						// notifypermissionlist never fills in `permission_id` (always
						// None here, confirmed live) - unlike e.g.
						// notifyservergrouppermlist, which does send explicit numeric
						// IDs. The catalog's IDs are only implicit in each entry's
						// position in the stream, so they're assigned from a running
						// counter instead of trusting the (absent) field.
						if let InMessage::PermList(list) = &msg {
							for part in list.iter() {
								let id = permission_catalog_next_id;
								permission_catalog_next_id += 1;
								permission_names.insert(
									id,
									(
										part.permission_name.clone().unwrap_or_default(),
										part.permission_description.clone().unwrap_or_default(),
									),
								);
							}
						}
					}
					if pending_perm_overview {
						if let InMessage::PermOverview(list) = &msg {
							let raw: Vec<(u32, i32, bool, bool)> = list
								.iter()
								.map(|part| {
									(
										part.permission_id.0,
										part.permission_value,
										part.permission_negated,
										part.permission_skip,
									)
								})
								.collect();
							pending_perm_overview = false;
							if pending_permission_list {
								// The name lookup hasn't come back yet - buffer the raw
								// values and resolve them once it does.
								pending_perm_overview_raw = Some(raw);
							} else {
								let entries: Vec<PermissionOverviewEntry> = raw
									.into_iter()
									.map(|(id, value, negated, skip)| {
										let (name, description) = permission_names
											.get(&id)
											.cloned()
											.unwrap_or_else(|| (format!("#{id}"), String::new()));
										PermissionOverviewEntry { name, description, value, negated, skip }
									})
									.collect();
								emit(&Event::PermissionOverview { entries });
							}
						}
					}
					if pending_perm_list.is_some() {
						let raw: Option<Vec<(u32, i32, bool, bool)>> = match &msg {
							InMessage::ServerGroupPermList(list) => Some(
								list.iter()
									.filter_map(|part| {
										part.permission_id.map(|id| {
											(id.0, part.permission_value, part.permission_negated, part.permission_skip)
										})
									})
									.collect(),
							),
							InMessage::ChannelGroupPermList(list) => Some(
								list.iter()
									.filter_map(|part| {
										part.permission_id.map(|id| {
											(id.0, part.permission_value, part.permission_negated, part.permission_skip)
										})
									})
									.collect(),
							),
							InMessage::ChannelPermList(list) => Some(
								list.iter()
									.map(|part| {
										(part.permission_id.0, part.permission_value, part.permission_negated, part.permission_skip)
									})
									.collect(),
							),
							InMessage::ClientPermList(list) => Some(
								list.iter()
									.filter_map(|part| {
										part.permission_id.map(|id| {
											(id.0, part.permission_value, part.permission_negated, part.permission_skip)
										})
									})
									.collect(),
							),
							InMessage::ChannelClientPermList(list) => Some(
								list.iter()
									.filter_map(|part| {
										part.permission_id.map(|id| {
											(id.0, part.permission_value, part.permission_negated, part.permission_skip)
										})
									})
									.collect(),
							),
							_ => None,
						};
						if let Some(raw) = raw {
							if pending_permission_list {
								// The name lookup hasn't come back yet - buffer the raw
								// values and resolve them once it does.
								pending_perm_list_raw = Some(raw);
							} else if let Some((scope, id1, id2)) = pending_perm_list.take() {
								let entries: Vec<PermissionOverviewEntry> = raw
									.into_iter()
									.map(|(id, value, negated, skip)| {
										let (name, description) = permission_names
											.get(&id)
											.cloned()
											.unwrap_or_else(|| (format!("#{id}"), String::new()));
										PermissionOverviewEntry { name, description, value, negated, skip }
									})
									.collect();
								emit(&Event::PermList { scope, id1, id2, entries });
							}
						}
					}
					if pending_file_list.is_some() {
						if let InMessage::FileList(list) = &msg {
							for part in list.iter() {
								file_list_buffer.push(FileListEntry {
									path: part.path.clone(),
									name: part.name.clone(),
									size: part.size,
									is_file: part.is_file,
									timestamp: part.date_time.to_string(),
								});
							}
						} else if let InMessage::FileListFinished(_) = &msg {
							if let Some((cid, path)) = pending_file_list.take() {
								emit(&Event::FileList { cid, path, entries: std::mem::take(&mut file_list_buffer) });
							}
						}
					}
				}
				Some(Ok(StreamItem::FileDownload(handle, result))) => {
					if let Some((cid, path)) = pending_downloads.remove(&handle.0) {
						// The whole download happens off the main select loop so a big
						// file does not stall channel switches, chat, etc. while in flight;
						// emit() is just a println! under the hood, so it is safe to call
						// from a spawned task even while the main loop is emitting too.
						// It goes out in TRANSFER_CHUNK_BYTES pieces but the browser
						// still assembles the whole file, so cap it - a server could
						// otherwise announce (or just send) gigabytes.
						let stream = result.stream;
						let announced_size = result.size;
						// Group/server icons are fetched automatically, without the user
						// asking, so they get a far smaller budget than explicit downloads.
						let limit = match path.as_str() {
							p if cid == 0 && p.starts_with("/icon_") => MAX_ICON_BYTES,
							p if cid == 0 && p.starts_with("/avatar_") => MAX_AVATAR_BYTES,
							_ => MAX_DOWNLOAD_BYTES,
						};
						tokio::spawn(async move {
							if announced_size > limit {
								emit(&Event::TransferError {
									message: format!("Download refused: {path} is larger than {} KiB", limit >> 10),
									cid,
									path,
								});
								return;
							}
							let mut stream = stream.take(limit + 1);
							let mut buf = vec![0u8; TRANSFER_CHUNK_BYTES];
							let mut offset = 0u64;
							loop {
								// Fill the whole chunk (or hit EOF) so every piece but the
								// last is exactly TRANSFER_CHUNK_BYTES - see its comment.
								let mut filled = 0;
								let started = std::time::Instant::now();
								let read = loop {
									match stream.read(&mut buf[filled..]).await {
										Ok(0) => break Ok(()),
										Ok(n) => {
											filled += n;
											if filled == buf.len() {
												break Ok(());
											}
										}
										Err(e) => break Err(e),
									}
								};
								if let Err(e) = read {
									emit(&Event::TransferError { message: format!("Download failed: {e}"), cid, path });
									return;
								}
								if offset + filled as u64 > limit {
									emit(&Event::TransferError {
										message: format!("Download aborted: {path} is larger than {} KiB", limit >> 10),
										cid,
										path,
									});
									return;
								}
								let done = filled < buf.len();
								let data = base64::engine::general_purpose::STANDARD.encode(&buf[..filled]);
								emit(&Event::FileDownloadChunk { cid, path: path.clone(), offset, data, done });
								ft_pace(&FT_LIMIT_DOWN, filled, started).await;
								if done {
									return;
								}
								offset += filled as u64;
							}
						});
					}
				}
				Some(Ok(StreamItem::FileUpload(handle, result))) => {
					if let Some((cid, path, data)) = pending_uploads.remove(&handle.0) {
						let seek = result.seek_position as usize;
						let mut stream = result.stream;
						tokio::spawn(async move {
							let slice = if seek < data.len() { &data[seek..] } else { &[][..] };
							for piece in slice.chunks(TRANSFER_CHUNK_BYTES) {
								let started = std::time::Instant::now();
								if let Err(e) = stream.write_all(piece).await {
									emit(&Event::TransferError { message: format!("Upload failed: {e}"), cid, path });
									return;
								}
								ft_pace(&FT_LIMIT_UP, piece.len(), started).await;
							}
							emit(&Event::FileUploadDone { cid, path });
						});
					}
				}
				Some(Ok(StreamItem::FiletransferFailed(handle, e))) => {
					let failed = pending_downloads
						.remove(&handle.0)
						.or_else(|| pending_uploads.remove(&handle.0).map(|(cid, path, _)| (cid, path)));
					if let Some((cid, path)) = failed {
						emit(&Event::TransferError { message: format!("File transfer failed: {e}"), cid, path });
					}
				}
				Some(Ok(StreamItem::DisconnectedTemporarily(reason))) => {
					ts_reconnecting = true;
					emit(&Event::Reconnecting { reason: format!("{reason:?}") });
				}
				Some(Ok(_)) => {}
				Some(Err(e)) => {
					emit(&Event::Disconnected { reason: e.to_string() });
					break;
				}
				None => {
					emit(&Event::Disconnected { reason: "server closed connection".into() });
					break;
				}
			},
			LoopOutcome::Resubscribe => {
				resubscribe_at = None;
				// Re-send channelsubscribeall so TeaSpeak pushes newly visible channels
				// (and clients in them) after our own server-group change.
				if let Err(e) = con.get_state()?.server.set_subscribed(true).send(&mut con) {
					emit(&Event::Error {
						message: format!("channelsubscribeall after perm change failed: {e}"),
					});
				}
			}
			LoopOutcome::ServerVarsRefresh => {
				if !ts_reconnecting {
					send_server_get_variables(&mut con);
				}
			}
			LoopOutcome::AudioTick => {
				if !audio_handler.get_queues().is_empty() {
					let mut buf = vec![0.0f32; FRAME_SAMPLES * OUT_CHANNELS];
					let stopped = audio_handler.fill_buffer(&mut buf);
					let mut talkers_changed = false;
					for id in stopped {
						if talking.remove(&id.0) {
							talkers_changed = true;
						}
					}
					if talkers_changed {
						emit(&Event::Talkers { clients: talking.iter().copied().collect() });
					}

					let mut bytes = Vec::with_capacity(buf.len() * 2);
					for sample in &buf {
						let clamped = sample.clamp(-1.0, 1.0);
						let pcm = (clamped * 32767.0) as i16;
						bytes.extend_from_slice(&pcm.to_le_bytes());
					}
					emit(&Event::AudioOut { pcm: base64::engine::general_purpose::STANDARD.encode(bytes) });
				}
			}
		}
	}

	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn chunk(offset: u64, total: u64, data: &[u8]) -> String {
		format!("7\t{offset}\t{total}\t/a b.txt\t{}", base64::engine::general_purpose::STANDARD.encode(data))
	}

	#[test]
	fn server_log_fields_are_camel_case() {
		let entry = ServerLogEntry::ClientChannelSwitch {
			client: "a".into(),
			from_channel: "b".into(),
			to_channel: "c".into(),
		};
		assert_eq!(
			serde_json::to_string(&entry).unwrap(),
			r#"{"kind":"clientChannelSwitch","client":"a","fromChannel":"b","toChannel":"c"}"#
		);
	}

	#[test]
	fn upload_chunks_assemble_in_order_and_reject_gaps() {
		let mut partials = HashMap::new();
		assert_eq!(take_upload_chunk(&mut partials, &chunk(0, 5, b"abc")), Ok(None));
		assert_eq!(
			take_upload_chunk(&mut partials, &chunk(3, 5, b"de")),
			Ok(Some((7, "/a b.txt".to_string(), b"abcde".to_vec())))
		);
		assert!(partials.is_empty());

		take_upload_chunk(&mut partials, &chunk(0, 5, b"abc")).unwrap();
		assert!(take_upload_chunk(&mut partials, &chunk(4, 5, b"e")).is_err());
		assert!(partials.is_empty(), "a gap drops the upload");
		assert!(take_upload_chunk(&mut partials, &chunk(0, MAX_UPLOAD_BYTES + 1, b"a")).is_err());

		// An empty file's only piece reaches us with its trailing tab trimmed off.
		assert_eq!(
			take_upload_chunk(&mut partials, chunk(0, 0, b"").trim_end()),
			Ok(Some((7, "/a b.txt".to_string(), Vec::new())))
		);
	}
}
