// Publishing a stream that TeamSpeak 6 clients can watch.
//
// The mirror image of stream.ts. Where a viewer answers an offer, a publisher
// makes one - TS6 puts the first SDP in `respondjoinstreamrequest`, so the
// side that owns the stream is the side that offers.
//
// The exchange, from our side:
//
//   1. setupStream    -> notifystreamstarted naming our own clid + the id
//   2. wait           <- notifyjoinstreamrequest, one per viewer
//   3. offer          respondJoinStream(accept, <our SDP>)
//   4. answer         <- {cmd:"answer", args:{answer:"<sdp>"}}
//   5. trickle ICE    both directions via {cmd:"iceCandidate"}
//
// TS6's P2P mode is a mesh: there is no SFU in the path, so every viewer gets
// its own peer connection and its own copy of the encoded media.

import { DEFAULT_ICE_SERVERS, type StreamEvent } from "./stream";

// The three enums below are read straight out of TS6's own UI bundle
// (main.js), not inferred - see ts6-re/findings §10.

/** `type` in `setupstream`: what is being captured. */
export const StreamSource = {
  NONE: 0,
  CAMERA: 1,
  SCREEN: 2,
  WINDOW: 3,
  EXISTING_SESSION: 4,
} as const;

/** `accessibility` in `setupstream`: TS6's Privacy setting. */
export const StreamAccess = {
  NONE: 0,
  PUBLIC: 1,
  CONTACTS_ONLY: 2,
  PRIVATE: 3,
} as const;

/** `mode` in `setupstream`: TS6's Connection Mode. */
export const StreamMode = {
  NONE: 0,
  P2P: 1,
  SFU: 2,
} as const;

export interface StreamPublishOptions {
  name: string;
  /** Screen/window via the browser's picker, or the webcam. */
  source: "display" | "camera";
  /** Send the capture's audio track too, when the source has one. */
  audio: boolean;
  /** One of StreamAccess. */
  accessibility: number;
  /** One of StreamMode. Only P2P is implemented; SFU needs the mediasoup path. */
  mode: number;
  /** 0 means unlimited. */
  viewerLimit: number;
  /** Capture height in pixels; 0 keeps the source's own resolution. */
  height: number;
  /** Capture frame rate; 0 leaves it to the browser. */
  fps: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  /**
   * What the encoder should protect when it runs out of bitrate. Slides and
   * code want "detail" (keep text sharp, drop frames); a game wants "motion".
   */
  contentHint: "motion" | "detail";
}

export interface StreamPublisherOptions {
  send: (message: Record<string, unknown>) => void;
  /** Needed to recognise our own `notifystreamstarted` among everyone's. */
  ownClientId: number;
  onStateChange?: (state: PublishState) => void;
  onViewersChange?: (viewers: number[]) => void;
  /** Join requests awaiting a decision, as [clid, message] pairs. */
  onPendingChange?: (pending: [number, string][]) => void;
  onError?: (error: string) => void;
  iceServers?: RTCIceServer[];
}

export type PublishState = "idle" | "starting" | "live" | "stopped";

interface Viewer {
  pc: RTCPeerConnection;
  /** Candidates that arrived before the answer; replayed after. */
  pending: RTCIceCandidateInit[];
  answered: boolean;
}

export class StreamPublisher {
  private readonly opts: StreamPublisherOptions;
  private readonly viewers = new Map<number, Viewer>();
  /** Requests waiting for the user to decide: clid -> the viewer's message. */
  private readonly pending = new Map<number, string>();
  /** Clients denied with "block"; they are refused without asking again. */
  private readonly blocked = new Set<number>();
  private media: MediaStream | null = null;
  private state: PublishState = "idle";
  private options: StreamPublishOptions | null = null;

  /** Assigned by the server, not by us; null until notifystreamstarted. */
  streamId: string | null = null;

  /** The local capture, for showing the user what they are sending. */
  get previewStream(): MediaStream | null {
    return this.media;
  }

  constructor(opts: StreamPublisherOptions) {
    this.opts = opts;
  }

  /**
   * Captures a screen or the webcam and announces the stream.
   *
   * Both capture APIs are secure-context-only, so this fails on a plain-http
   * origin - the same limitation the microphone already has.
   */
  async start(options: StreamPublishOptions): Promise<void> {
    if (this.state === "live" || this.state === "starting") return;
    const camera = options.source === "camera";
    if (!(camera ? navigator.mediaDevices?.getUserMedia : navigator.mediaDevices?.getDisplayMedia)) {
      this.fail("Streaming requires HTTPS (or localhost) - the site is not a secure context.");
      return;
    }

    this.setState("starting");
    this.options = options;

    const video: MediaTrackConstraints = {};
    if (options.height > 0) video.height = { ideal: options.height };
    if (options.fps > 0) video.frameRate = { ideal: options.fps };

    try {
      const constraints = { video: Object.keys(video).length > 0 ? video : true };
      // A camera's "audio" would be the microphone, which already goes out as
      // voice - sending it again would only echo.
      this.media = camera
        ? await navigator.mediaDevices.getUserMedia({ ...constraints, audio: false })
        : await navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: options.audio });
    } catch (err) {
      this.setState("idle");
      this.fail(`Could not capture the ${camera ? "camera" : "screen"}: ${describe(err)}`);
      return;
    }

    for (const track of this.media.getVideoTracks()) track.contentHint = options.contentHint;

    // The browser's own "stop sharing" bar bypasses our UI entirely, so the
    // track ending is the authoritative signal that the stream is over.
    for (const track of this.media.getTracks()) {
      track.onended = () => this.stop();
    }

    this.opts.send({
      type: "setupStream",
      name: options.name,
      // The browser's own picker decides whether this is a whole screen or a
      // single window, so the type is read back off the track rather than
      // asked for up front.
      streamType: this.detectSourceType(),
      bitrate: options.videoBitrateKbps * 1000,
      accessibility: options.accessibility,
      mode: options.mode,
      viewerLimit: options.viewerLimit,
      audio: options.audio && this.media.getAudioTracks().length > 0,
    });
  }

  /** Feeds one `streamEvent` in; events for other streams are ignored. */
  handleEvent(event: StreamEvent): void {
    switch (event.name) {
      case "notifystreamstarted":
        // Everyone in the channel sees this, so the clid decides whether it
        // is the answer to our own setupstream.
        if (Number(event.args.clid) === this.opts.ownClientId && event.args.id) {
          this.streamId = event.args.id;
          this.setState("live");
        }
        break;
      case "notifyjoinstreamrequest":
        if (event.args.id === this.streamId) void this.admit(event.args);
        break;
      case "notifystreamsignaling":
        if (event.args.id === this.streamId) void this.handleSignaling(event.args);
        break;
      case "notifystreamclientleft":
        if (event.args.id === this.streamId) this.dropViewer(Number(event.args.clid));
        break;
      case "notifystreamstopped":
        if (event.args.id === this.streamId) this.teardown("stopped");
        break;
    }
  }

  /**
   * Decides what to do with an incoming join request.
   *
   * This mirrors TS6's own publisher-side rule, which is the only place either
   * setting is enforced at all - the server stores `accessibility` and
   * `viewer_limit`, echoes them back, and then forwards every request anyway
   * (verified live: a PRIVATE stream at viewer_limit=1 still had both viewers
   * announced to us).
   *
   * The important half is what happens to a request we do not take: TS6 leaves
   * it *pending* rather than refusing it. A refusal is not sticky - TS6's own
   * "block" path is deny plus a ban - so a refused client simply asks again, in
   * a loop, and shows its user nothing. Left pending, it asks once and displays
   * "waiting for access" until we answer.
   */
  private async admit(args: Record<string, string>): Promise<void> {
    const clid = Number(args.clid);
    if (!Number.isFinite(clid) || !this.media || !this.streamId) return;

    // is_remove=1 is how TS6 says "stop watching"; the same notify carries it.
    if (args.is_remove === "1") {
      this.dropViewer(clid);
      return;
    }
    if (this.viewers.has(clid) || this.pending.has(clid)) return;

    // Explicitly blocked earlier: refuse without bothering the user again.
    if (this.blocked.has(clid)) {
      this.refuse(clid, "Blocked");
      return;
    }

    const limit = this.options?.viewerLimit ?? 0;
    const full = limit > 0 && this.viewers.size >= limit;
    const autoAccept = this.options?.accessibility === StreamAccess.PUBLIC && !full;

    if (!autoAccept) {
      // CONTACTS_ONLY behaves as PRIVATE here: the contact list is a TS6
      // account feature webspeak3 has no access to, so it cannot be consulted.
      this.pending.set(clid, args.msg ?? "");
      this.notifyPending();
      return;
    }

    await this.openTo(clid);
  }

  /** Lets a pending viewer in. Called by admit() or by the user. */
  async approve(clid: number): Promise<void> {
    if (!this.pending.delete(clid)) return;
    this.notifyPending();
    await this.openTo(clid);
  }

  /**
   * Turns a pending viewer away. `block` also remembers the refusal, which is
   * what makes it stick - TS6 pairs its deny with a ban for the same reason.
   */
  deny(clid: number, block = false): void {
    this.pending.delete(clid);
    if (block) this.blocked.add(clid);
    this.notifyPending();
    this.refuse(clid, block ? "Blocked" : "Denied");
  }

  private refuse(clid: number, message: string): void {
    if (!this.streamId) return;
    this.opts.send({
      type: "respondJoinStream",
      streamId: this.streamId,
      clientId: clid,
      accept: false,
      message,
    });
  }

  /** Builds the peer connection for a viewer we have decided to let in. */
  private async openTo(clid: number): Promise<void> {
    if (!this.media || !this.streamId || this.viewers.has(clid)) return;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS });
    const viewer: Viewer = { pc, pending: [], answered: false };
    this.viewers.set(clid, viewer);

    for (const track of this.media.getTracks()) pc.addTrack(track, this.media);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.signal(clid, "iceCandidate", {
        sdp: ev.candidate.candidate,
        mid: ev.candidate.sdpMid ?? "0",
        mLine: ev.candidate.sdpMLineIndex ?? 0,
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.dropViewer(clid);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.applySendParameters(pc);
      this.opts.send({
        type: "respondJoinStream",
        streamId: this.streamId,
        clientId: clid,
        accept: true,
        offer: offer.sdp ?? "",
      });
      this.notifyViewers();
    } catch (err) {
      this.dropViewer(clid);
      this.fail(`Could not offer the stream to client ${clid}: ${describe(err)}`);
    }
  }

  private async handleSignaling(args: Record<string, string>): Promise<void> {
    const clid = Number(args.clid);
    const viewer = this.viewers.get(clid);
    if (!viewer) return;

    let msg: { cmd: string; args: unknown };
    try {
      msg = JSON.parse(args.json ?? "");
    } catch {
      return;
    }

    const payload = msg.args as Record<string, unknown> | string | null;
    switch (msg.cmd) {
      case "answer": {
        // Same key rule as the sending side: the key is named after the cmd.
        const sdp =
          typeof payload === "string"
            ? payload
            : typeof payload?.answer === "string"
              ? payload.answer
              : typeof payload?.sdp === "string"
                ? payload.sdp
                : null;
        if (!sdp) return;
        try {
          await viewer.pc.setRemoteDescription({ type: "answer", sdp });
          viewer.answered = true;
          const pending = viewer.pending;
          viewer.pending = [];
          for (const c of pending) {
            try {
              await viewer.pc.addIceCandidate(c);
            } catch (err) {
              console.warn("[publish] ignoring buffered ICE candidate:", describe(err));
            }
          }
        } catch (err) {
          this.fail(`Could not accept the viewer's answer: ${describe(err)}`);
        }
        break;
      }
      case "iceCandidate": {
        if (typeof payload !== "object" || payload === null) return;
        const candidate = payload.sdp;
        if (typeof candidate !== "string" || !candidate) return;
        const init: RTCIceCandidateInit = {
          candidate,
          sdpMid: typeof payload.mid === "string" ? payload.mid : undefined,
          sdpMLineIndex: typeof payload.mLine === "number" ? payload.mLine : undefined,
        };
        // TS6 trickles from the moment it gets the offer, so these routinely
        // beat its own answer. Holding them is not an edge case.
        if (!viewer.answered) {
          viewer.pending.push(init);
          return;
        }
        try {
          await viewer.pc.addIceCandidate(init);
        } catch (err) {
          console.warn("[publish] ignoring ICE candidate:", describe(err));
        }
        break;
      }
    }
  }

  /**
   * Caps each sender at the configured bitrate and pins the resolution.
   *
   * `setupstream`'s `bitrate` is only what the stream *advertises* - the
   * server does not even echo our value back unchanged, and it certainly does
   * not reach the encoder. The actual limit is a sender parameter, and the
   * encodings it lives on only exist once a local description is set.
   *
   * `degradationPreference` matters just as much. Its default for a track
   * hinted "motion" is to protect the frame rate and shrink the picture, which
   * for a screen share is exactly backwards: the user picked 1080p, so 1080p is
   * the thing to keep. Measured on a 1440x1080 capture at a 6000 kbps cap:
   *
   *   default / maintain-framerate / balanced -> 480x270, a 3x downscale
   *   maintain-resolution                     -> 1440x810, no downscale
   *
   * Without this the encoder collapses within seconds of the connection coming
   * up and never recovers, and every resolution setting above 360p is a lie.
   */
  private async applySendParameters(pc: RTCPeerConnection): Promise<void> {
    const options = this.options;
    if (!options) return;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const video = sender.track.kind === "video";
      const kbps = video ? options.videoBitrateKbps : options.audioBitrateKbps;
      const params = sender.getParameters();
      if (video) params.degradationPreference = "maintain-resolution";
      if (kbps > 0) {
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        for (const encoding of params.encodings) encoding.maxBitrate = kbps * 1000;
      }
      try {
        await sender.setParameters(params);
      } catch (err) {
        // Not fatal - the stream still runs, just uncapped and free to shrink.
        console.warn("[publish] could not apply the send parameters:", describe(err));
      }
    }
  }

  /**
   * Maps the capture to TS6's source enum.
   *
   * `displaySurface` is what the user actually picked in the browser's own
   * share dialog, so it is more truthful than anything we could ask for in
   * advance. A browser tab has no TS6 equivalent and reads closest to a window.
   */
  private detectSourceType(): number {
    if (this.options?.source === "camera") return StreamSource.CAMERA;
    const surface = this.media?.getVideoTracks()[0]?.getSettings().displaySurface;
    return surface === "monitor" ? StreamSource.SCREEN : StreamSource.WINDOW;
  }

  private dropViewer(clid: number): void {
    // Someone can also leave while their request is still queued - by closing
    // TS6, or by giving up on "waiting for access". The row has to go with
    // them, or the user is left approving a viewer who is no longer there.
    if (this.pending.delete(clid)) this.notifyPending();

    const viewer = this.viewers.get(clid);
    if (!viewer) return;
    this.viewers.delete(clid);
    viewer.pc.close();
    this.notifyViewers();
  }

  /** Stops the capture and takes the stream down. Safe to call twice. */
  stop(): void {
    if (this.state === "idle" || this.state === "stopped") return;
    if (this.streamId) this.opts.send({ type: "stopStream", streamId: this.streamId });
    this.teardown("stopped");
  }

  private teardown(state: PublishState): void {
    for (const [, viewer] of this.viewers) viewer.pc.close();
    this.viewers.clear();
    this.pending.clear();
    this.blocked.clear();
    for (const track of this.media?.getTracks() ?? []) track.stop();
    this.media = null;
    this.streamId = null;
    this.options = null;
    this.notifyViewers();
    this.notifyPending();
    this.setState(state);
  }

  private signal(clid: number, cmd: string, args: unknown): void {
    this.opts.send({
      type: "streamSignal",
      streamId: this.streamId,
      clientId: clid,
      payload: { cmd, args },
    });
  }

  private setState(state: PublishState): void {
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private notifyViewers(): void {
    this.opts.onViewersChange?.([...this.viewers.keys()]);
  }

  private notifyPending(): void {
    this.opts.onPendingChange?.([...this.pending.entries()]);
  }

  private fail(message: string): void {
    this.opts.onError?.(message);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
