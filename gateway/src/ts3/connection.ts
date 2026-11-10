import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bridges to the real TeamSpeak client protocol via the `ts-connector` Rust
 * binary (built on top of tsclientlib), since that protocol can't be spoken
 * from Node/the browser directly. This process is spawned per connection and
 * emits newline-delimited JSON events on stdout.
 */

export interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

/**
 * The `setupstream` arguments. TS6 always sends all of them, so none are
 * optional here - the defaults live in the caller, not on the wire.
 */
export interface StreamSetupOptions {
  name: string;
  /** Source kind; a real TS6 screen share sends 3. */
  type: number;
  bitrate: number;
  /** TS6's Privacy setting: who may join without being asked. */
  accessibility: number;
  /** Connection mode - peer-to-peer or via the server's SFU. */
  mode: number;
  /** 0 means unlimited. */
  viewerLimit: number;
  audio: boolean;
}

export interface ClientInfo {
  id: number;
  channel: number;
  name: string;
  inputMuted: boolean;
  outputMuted: boolean;
  inputHardwareEnabled: boolean;
  away: boolean;
  awayMessage: string;
  isChannelCommander: boolean;
  country: string;
  uid: string;
  databaseId: number;
  channelGroup: number;
  serverGroups: number[];
  hasTalkPower: boolean;
  /** ServerQuery client; UI may hide these unless enabled per favorite. */
  isQuery: boolean;
  /** Broadcasting a TS6 Stream/Call. The stream id is fetched separately. */
  isStreaming: boolean;
  /** MD5 of the avatar (`client_flag_avatar`), empty without one. */
  avatarHash: string;
}

export interface GroupEntry {
  id: number;
  name: string;
  iconId: number;
}

export interface PermissionOverviewEntry {
  name: string;
  description: string;
  value: number;
  negated: boolean;
  skip: boolean;
}

export interface PermissionCatalogEntry {
  id: number;
  name: string;
  description: string;
}

export type PermScope = "server" | "channelgroup" | "channel" | "client" | "channelclient";

export interface BanListEntry {
  banId: number;
  ip: string;
  name: string;
  uid: string;
  lastNickname: string;
  created: string;
  durationSecs: number;
  invokerName: string;
  reason: string;
  enforcements: number;
}

export interface ComplainListEntry {
  targetClientDbId: number;
  targetName: string;
  fromClientDbId: number;
  fromName: string;
  message: string;
  timestamp: string;
}

export interface OfflineMessageListEntry {
  messageId: number;
  clientUid: string;
  subject: string;
  timestamp: string;
  isRead: boolean;
}

export interface FileListEntry {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  timestamp: string;
}

export type ServerLogEntry =
  | { kind: "clientJoin"; client: string; channel: string }
  | { kind: "clientLeave"; client: string }
  | { kind: "clientChannelSwitch"; client: string; fromChannel: string; toChannel: string }
  | { kind: "clientChannelGroupAssigned"; client: string; group: string }
  | { kind: "channelCreated"; channel: string }
  | { kind: "channelDeleted"; channel: string }
  | { kind: "channelEdited"; channel: string }
  | { kind: "serverEdited" }
  | { kind: "permissionError"; action: string };

export type Ts3ConnectionEvent =
  | {
      type: "connected";
      welcomeMessage: string;
      serverName: string;
      serverMaxClients: number;
      serverVersion: string;
      serverLicense: string;
      serverLicenseId: number;
      serverBannerUrl: string;
      identity: string;
    }
  | { type: "channels"; channels: ChannelInfo[]; clients: ClientInfo[]; ownClientId: number; serverMaxClients: number; serverClientsOnline: number; serverChannelsOnline: number }
  | { type: "chatMessage"; from: string; message: string }
  | { type: "serverMessage"; from: string; message: string }
  | { type: "privateMessage"; partnerId: number; partnerName: string; fromSelf: boolean; message: string }
  | { type: "poke"; from: string; message: string }
  | { type: "audioOut"; pcm: string }
  | { type: "talkers"; clients: number[] }
  | { type: "whisperReceived"; clientId: number }
  | { type: "disconnected"; reason: string }
  | { type: "reconnecting"; reason: string }
  | { type: "reconnected" }
  | { type: "error"; message: string; cid?: number; path?: string }
  | { type: "channelPasswordRequired"; channelId: number }
  | ({ type: "serverLog" } & ServerLogEntry)
  | {
      type: "clientConnectionInfo";
      clientId: number;
      pingMs: number | null;
      connectedSecs: number | null;
      ip: string | null;
      packetsSent: number;
      bytesSent: number;
      packetsReceived: number;
      bytesReceived: number;
      packetLossPercent: number;
    }
  | {
      type: "serverConnectionInfo";
      pingMs: number;
      connectedSecs: number;
      packetLossPercent: number;
      packetsSentTotal: number;
      bytesSentTotal: number;
      packetsReceivedTotal: number;
      bytesReceivedTotal: number;
      bandwidthSentLastSecond: number;
      bandwidthReceivedLastSecond: number;
      bandwidthSentLastMinute: number;
      bandwidthReceivedLastMinute: number;
      filetransferBandwidthSent: number;
      filetransferBandwidthReceived: number;
      filetransferBytesSent: number;
      filetransferBytesReceived: number;
    }
  | { type: "serverProtocolLog"; lines: string[] }
  | { type: "banList"; entries: BanListEntry[] }
  | { type: "complainList"; entries: ComplainListEntry[] }
  | { type: "offlineMessageList"; entries: OfflineMessageListEntry[] }
  | {
      type: "offlineMessage";
      messageId: number;
      clientUid: string;
      subject: string;
      message: string;
      timestamp: string;
    }
  | { type: "channelGroupList"; entries: GroupEntry[] }
  | { type: "serverGroupList"; entries: GroupEntry[] }
  | { type: "permissionOverview"; entries: PermissionOverviewEntry[] }
  | { type: "fileList"; cid: number; path: string; entries: FileListEntry[] }
  | { type: "fileDownloadChunk"; cid: number; path: string; offset: number; data: string; done: boolean }
  | { type: "fileUploadDone"; cid: number; path: string }
  | { type: "permList"; scope: PermScope; id1: number; id2: number | null; entries: PermissionOverviewEntry[] }
  | { type: "permissionCatalog"; entries: PermissionCatalogEntry[] }
  /** TS6 Stream/Call signaling, forwarded verbatim; `args` is already unescaped. */
  | { type: "streamEvent"; name: string; args: Record<string, string> };

export type ServerType = "teamspeak" | "teaspeak" | "auto" | "ts2";

export interface Ts3ConnectOptions {
  host: string;
  nickname: string;
  serverPassword?: string;
  channelPassword?: string;
  defaultChannel?: string;
  /** Previously-issued identity (from a prior "connected" event) to keep
   *  the same client UID across sessions. Omit to get a freshly generated one. */
  identity?: string;
  /** Protocol / server dialect hint for the connector (`auto` when omitted). */
  serverType?: ServerType;
  /** One-time privilege key / token to redeem on connect. */
  privilegeKey?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_BIN =
  process.env.CONNECTOR_BIN ??
  path.resolve(
    __dirname,
    "../../../connector/target/debug",
    process.platform === "win32" ? "ts-connector.exe" : "ts-connector"
  );

export class Ts3Connection {
  private listeners = new Set<(event: Ts3ConnectionEvent) => void>();
  private child?: ChildProcessWithoutNullStreams;
  // Set once the child is confirmed gone - either it exited, or it never
  // managed to spawn at all. disconnect() uses this to skip waiting on an
  // "exit" event that already fired (and so will never fire again) before
  // disconnect() got a chance to listen for it.
  private childGone = false;

  constructor(private options: Ts3ConnectOptions) {}

  onEvent(listener: (event: Ts3ConnectionEvent) => void): void {
    this.listeners.add(listener);
  }

  private emit(event: Ts3ConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Every connector command is exactly one line on this stdin protocol.
   *  Several call sites forward fields (permission scope/ids, whisper
   *  targets, ...) without stripping embedded CR/LF first - routing every
   *  write through here means a stray newline in any of them can never
   *  smuggle in a second, attacker-chosen command. */
  private writeLine(line: string): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${line.replace(/[\r\n]+/g, " ")}\n`);
  }

  async connect(): Promise<void> {
    // "--flag=value" so a value starting with "-" can never be parsed as a
    // flag of its own. Secrets go through the environment instead of argv,
    // which any process on the host can read via `ps`.
    const args = [`--address=${this.options.host}`, `--nickname=${this.options.nickname}`];
    if (this.options.defaultChannel) args.push(`--default-channel=${this.options.defaultChannel}`);
    if (this.options.serverType) args.push(`--server-type=${this.options.serverType}`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.serverPassword) env.TS_SERVER_PASSWORD = this.options.serverPassword;
    if (this.options.channelPassword) env.TS_CHANNEL_PASSWORD = this.options.channelPassword;
    if (this.options.identity) env.TS_IDENTITY = this.options.identity;
    if (this.options.privilegeKey) env.TS_PRIVILEGE_KEY = this.options.privilegeKey;
    this.child = spawn(CONNECTOR_BIN, args, { env });

    // The connector can exit on its own (e.g. the TS3 server drops it) and close
    // its stdin pipe before writeLine()'s `this.child.killed` guard has any way
    // to know - killed only reflects Node-side .kill() calls. A write to that
    // closed pipe emits an unhandled 'error' (EPIPE) on the stream, which Node
    // treats as fatal and crashes the whole gateway process, killing every
    // other client's session too. Listening here turns it into a normal,
    // isolated write failure instead of a process-wide crash.
    this.child.stdin.on("error", () => {});

    // spawn() itself can fail asynchronously - wrong CONNECTOR_BIN path, no
    // exec permission, or (under load, with many connections already open)
    // EMFILE/ENFILE from running out of file descriptors. That failure surfaces
    // as an unhandled 'error' event on the child process object, which is just
    // as fatal to the whole gateway process as the stdin case above - and far
    // more likely to hit at the worst possible time, since a file-descriptor
    // limit is reached exactly when the most other connections are active.
    this.child.on("error", (err) => {
      this.childGone = true;
      this.emit({ type: "error", message: `Connector failed to start: ${err.message}` });
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        interface RawClientInfo {
          id: number;
          channel: number;
          name: string;
          input_muted: boolean;
          output_muted: boolean;
          input_hardware_enabled: boolean;
          away: boolean;
          away_message: string;
          is_channel_commander: boolean;
          country: string;
          uid: string;
          database_id: number;
          channel_group: number;
          server_groups: number[];
          has_talk_power: boolean;
          is_query?: boolean;
          is_streaming?: boolean;
          avatar_hash?: string;
        }

        interface RawChannelInfo {
          id: number;
          parent: number;
          order: number;
          name: string;
          topic: string;
          codec: string;
          max_clients: number | null;
          has_password: boolean;
        }

        const event = JSON.parse(line) as
          | {
              type: "connected";
              welcome_message: string;
              server_name: string;
              server_max_clients: number;
              server_version: string;
              server_license: string;
              server_license_id?: number;
              server_banner_url: string;
              identity: string;
            }
          | {
              type: "channels";
              channels: RawChannelInfo[];
              clients: RawClientInfo[];
              own_client_id?: number;
              server_max_clients?: number;
              server_clients_online?: number;
              server_channels_online?: number;
            }
          | { type: "chatMessage"; from: string; message: string }
          | { type: "serverMessage"; from: string; message: string }
          | { type: "privateMessage"; partner_id: number; partner_name: string; from_self: boolean; message: string }
          | { type: "poke"; from: string; message: string }
          | { type: "audioOut"; pcm: string }
          | { type: "talkers"; clients: number[] }
          | { type: "whisperReceived"; clientId: number }
          | { type: "disconnected"; reason: string }
          | { type: "reconnecting"; reason: string }
          | { type: "reconnected" }
          | { type: "error"; message: string; cid?: number; path?: string }
          | { type: "channelPasswordRequired"; channel_id: number }
          | ({ type: "serverLog" } & ServerLogEntry)
          | {
              type: "clientConnectionInfo";
              client_id: number;
              ping_ms: number | null;
              connected_secs: number | null;
              ip: string | null;
              packets_sent: number;
              bytes_sent: number;
              packets_received: number;
              bytes_received: number;
              packet_loss_percent: number;
            }
          | {
              type: "serverConnectionInfo";
              ping_ms: number;
              connected_secs: number;
              packet_loss_percent: number;
              packets_sent_total: number;
              bytes_sent_total: number;
              packets_received_total: number;
              bytes_received_total: number;
              bandwidth_sent_last_second: number;
              bandwidth_received_last_second: number;
              bandwidth_sent_last_minute?: number;
              bandwidth_received_last_minute?: number;
              filetransfer_bandwidth_sent?: number;
              filetransfer_bandwidth_received?: number;
              filetransfer_bytes_sent?: number;
              filetransfer_bytes_received?: number;
            }
          | { type: "serverProtocolLog"; lines: string[] }
          | {
              type: "banList";
              entries: {
                ban_id: number;
                ip: string;
                name: string;
                uid: string;
                last_nickname: string;
                created: string;
                duration_secs: number;
                invoker_name: string;
                reason: string;
                enforcements: number;
              }[];
            }
          | {
              type: "complainList";
              entries: {
                target_client_db_id: number;
                target_name: string;
                from_client_db_id: number;
                from_name: string;
                message: string;
                timestamp: string;
              }[];
            }
          | {
              type: "offlineMessageList";
              entries: {
                message_id: number;
                client_uid: string;
                subject: string;
                timestamp: string;
                is_read: boolean;
              }[];
            }
          | {
              type: "offlineMessage";
              message_id: number;
              client_uid: string;
              subject: string;
              message: string;
              timestamp: string;
            }
          | { type: "channelGroupList"; entries: GroupEntry[] }
          | { type: "serverGroupList"; entries: GroupEntry[] }
          | {
              type: "permissionOverview";
              entries: { name: string; description: string; value: number; negated: boolean; skip: boolean }[];
            }
          | { type: "fileList"; cid: number; path: string; entries: FileListEntry[] }
          | { type: "fileDownloadChunk"; cid: number; path: string; offset: number; data: string; done: boolean }
          | { type: "fileUploadDone"; cid: number; path: string }
          | { type: "permList"; scope: PermScope; id1: number; id2: number | null; entries: PermissionOverviewEntry[] }
          | { type: "permissionCatalog"; entries: PermissionCatalogEntry[] }
          | { type: "streamEvent"; name: string; args: Record<string, string> };

        if (event.type === "connected") {
          this.emit({
            type: "connected",
            welcomeMessage: event.welcome_message,
            serverName: event.server_name,
            serverMaxClients: event.server_max_clients,
            serverVersion: event.server_version,
            serverLicense: event.server_license,
            serverLicenseId: event.server_license_id ?? 0,
            serverBannerUrl: event.server_banner_url,
            identity: event.identity,
          });
        } else if (event.type === "channels") {
          this.emit({
            type: "channels",
            channels: event.channels.map((ch) => ({
              id: ch.id,
              parent: ch.parent,
              order: ch.order,
              name: ch.name,
              topic: ch.topic,
              codec: ch.codec,
              maxClients: ch.max_clients,
              hasPassword: ch.has_password,
            })),
            clients: event.clients.map((c) => ({
              id: c.id,
              channel: c.channel,
              name: c.name,
              inputMuted: c.input_muted,
              outputMuted: c.output_muted,
              inputHardwareEnabled: c.input_hardware_enabled,
              away: c.away,
              awayMessage: c.away_message,
              isChannelCommander: c.is_channel_commander,
              country: c.country,
              uid: c.uid,
              databaseId: c.database_id,
              channelGroup: c.channel_group,
              serverGroups: c.server_groups,
              hasTalkPower: c.has_talk_power,
              isQuery: Boolean(c.is_query),
              isStreaming: Boolean(c.is_streaming),
              avatarHash: c.avatar_hash ?? "",
            })),
            ownClientId: event.own_client_id ?? 0,
            serverMaxClients: event.server_max_clients ?? 0,
            serverClientsOnline: event.server_clients_online ?? event.clients.length,
            serverChannelsOnline: event.server_channels_online ?? event.channels.length,
          });
        } else if (event.type === "privateMessage") {
          this.emit({
            type: "privateMessage",
            partnerId: event.partner_id,
            partnerName: event.partner_name,
            fromSelf: event.from_self,
            message: event.message,
          });
        } else if (event.type === "clientConnectionInfo") {
          this.emit({
            type: "clientConnectionInfo",
            clientId: event.client_id,
            pingMs: event.ping_ms,
            connectedSecs: event.connected_secs,
            ip: event.ip,
            packetsSent: event.packets_sent,
            bytesSent: event.bytes_sent,
            packetsReceived: event.packets_received,
            bytesReceived: event.bytes_received,
            packetLossPercent: event.packet_loss_percent,
          });
        } else if (event.type === "serverConnectionInfo") {
          this.emit({
            type: "serverConnectionInfo",
            pingMs: event.ping_ms,
            connectedSecs: event.connected_secs,
            packetLossPercent: event.packet_loss_percent,
            packetsSentTotal: event.packets_sent_total,
            bytesSentTotal: event.bytes_sent_total,
            packetsReceivedTotal: event.packets_received_total,
            bytesReceivedTotal: event.bytes_received_total,
            bandwidthSentLastSecond: event.bandwidth_sent_last_second,
            bandwidthReceivedLastSecond: event.bandwidth_received_last_second,
            bandwidthSentLastMinute: event.bandwidth_sent_last_minute ?? 0,
            bandwidthReceivedLastMinute: event.bandwidth_received_last_minute ?? 0,
            filetransferBandwidthSent: event.filetransfer_bandwidth_sent ?? 0,
            filetransferBandwidthReceived: event.filetransfer_bandwidth_received ?? 0,
            filetransferBytesSent: event.filetransfer_bytes_sent ?? 0,
            filetransferBytesReceived: event.filetransfer_bytes_received ?? 0,
          });
        } else if (event.type === "banList") {
          this.emit({
            type: "banList",
            entries: event.entries.map((e) => ({
              banId: e.ban_id,
              ip: e.ip,
              name: e.name,
              uid: e.uid,
              lastNickname: e.last_nickname,
              created: e.created,
              durationSecs: e.duration_secs,
              invokerName: e.invoker_name,
              reason: e.reason,
              enforcements: e.enforcements,
            })),
          });
        } else if (event.type === "complainList") {
          this.emit({
            type: "complainList",
            entries: event.entries.map((e) => ({
              targetClientDbId: e.target_client_db_id,
              targetName: e.target_name,
              fromClientDbId: e.from_client_db_id,
              fromName: e.from_name,
              message: e.message,
              timestamp: e.timestamp,
            })),
          });
        } else if (event.type === "offlineMessageList") {
          this.emit({
            type: "offlineMessageList",
            entries: event.entries.map((e) => ({
              messageId: e.message_id,
              clientUid: e.client_uid,
              subject: e.subject,
              timestamp: e.timestamp,
              isRead: e.is_read,
            })),
          });
        } else if (event.type === "offlineMessage") {
          this.emit({
            type: "offlineMessage",
            messageId: event.message_id,
            clientUid: event.client_uid,
            subject: event.subject,
            message: event.message,
            timestamp: event.timestamp,
          });
        } else if (event.type === "channelPasswordRequired") {
          this.emit({ type: "channelPasswordRequired", channelId: event.channel_id });
        } else {
          this.emit(event);
        }
      } catch {
        this.emit({ type: "error", message: `Unparseable connector output: ${line}` });
      }
    });

    // stderr carries diagnostic tracing output from the connector (e.g. protocol
    // schema warnings), not application-level errors - keep it server-side only.
    this.child.stderr.on("data", (data) => {
      console.error(`[ts-connector] ${data.toString()}`);
    });

    this.child.on("exit", (code) => {
      this.childGone = true;
      if (code !== 0) {
        this.emit({ type: "error", message: `Connector exited with code ${code}` });
      }
    });
  }

  async switchChannel(channelId: number, channelPassword?: string): Promise<void> {
    const id = Number(channelId);
    if (!Number.isFinite(id)) return;
    // The password travels base64-encoded on this line-based stdin protocol
    // so it can safely contain spaces or other characters.
    const passwordArg = channelPassword ? ` ${Buffer.from(channelPassword, "utf8").toString("base64")}` : "";
    this.writeLine(`switch ${id}${passwordArg}`);
  }

  async moveClient(clientId: number, channelId: number, channelPassword?: string): Promise<void> {
    const clid = Number(clientId);
    const cid = Number(channelId);
    if (!Number.isFinite(clid) || !Number.isFinite(cid)) return;
    const passwordArg = channelPassword ? ` ${Buffer.from(channelPassword, "utf8").toString("base64")}` : "";
    this.writeLine(`moveclient ${clid} ${cid}${passwordArg}`);
  }

  async getClientConnectionInfo(clientId: number): Promise<void> {
    this.writeLine(`clientconninfo ${clientId}`);
  }

  async getServerConnectionInfo(): Promise<void> {
    this.writeLine(`serverconninfo`);
  }

  async kickFromChannel(clientId: number, reason: string): Promise<void> {
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    this.writeLine(`kickchannel ${clientId} ${sanitized}`);
  }

  async kickFromServer(clientId: number, reason: string): Promise<void> {
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    this.writeLine(`kickserver ${clientId} ${sanitized}`);
  }

  async banClient(clientId: number, seconds: number, reason: string): Promise<void> {
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    this.writeLine(`banclient ${clientId} ${Math.max(0, Math.floor(seconds))} ${sanitized}`);
  }

  /** Every field is optional - only send what actually changed. JSON.stringify
   *  already escapes embedded newlines, so this is safe as a single stdin line
   *  without extra sanitization. */
  async editServer(payload: {
    name?: string;
    welcomeMessage?: string;
    password?: string;
    maxClients?: number;
    hostmessage?: string;
    hostmessageMode?: string;
    hostbannerUrl?: string;
    hostbannerGfxUrl?: string;
    hostbannerGfxIntervalSecs?: number;
    hostbannerMode?: string;
    hostbuttonTooltip?: string;
    hostbuttonUrl?: string;
    hostbuttonGfxUrl?: string;
    nickname?: string;
    phoneticName?: string;
    codecEncryptionMode?: string;
  }): Promise<void> {
    this.writeLine(`serveredit ${JSON.stringify(payload)}`);
  }

  async getServerLog(): Promise<void> {
    this.writeLine(`serverlog`);
  }

  async getBanList(): Promise<void> {
    this.writeLine(`banlist`);
  }

  async deleteBan(banId: number): Promise<void> {
    this.writeLine(`bandel ${banId}`);
  }

  async deleteAllBans(): Promise<void> {
    this.writeLine(`bandelall`);
  }

  async getComplainList(): Promise<void> {
    this.writeLine(`complainlist`);
  }

  async deleteComplaint(targetClientDbId: number, fromClientDbId: number): Promise<void> {
    this.writeLine(`complaindel ${targetClientDbId} ${fromClientDbId}`);
  }

  async deleteAllComplaintsFor(targetClientDbId: number): Promise<void> {
    this.writeLine(`complaindelall ${targetClientDbId}`);
  }

  async getOfflineMessageList(): Promise<void> {
    this.writeLine(`messagelist`);
  }

  async getOfflineMessage(messageId: number): Promise<void> {
    this.writeLine(`messageget ${messageId}`);
  }

  async sendOfflineMessage(clientUid: string, subject: string, message: string): Promise<void> {
    const sanitize = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
    this.writeLine(`messageadd ${sanitize(clientUid)}\t${sanitize(subject)}\t${sanitize(message)}`);
  }

  async deleteOfflineMessage(messageId: number): Promise<void> {
    this.writeLine(`messagedel ${messageId}`);
  }

  async markOfflineMessageRead(messageId: number): Promise<void> {
    this.writeLine(`messageupdateflag ${messageId} 1`);
  }

  async getChannelGroupList(): Promise<void> {
    this.writeLine(`channelgrouplist`);
  }

  async getServerGroupList(): Promise<void> {
    this.writeLine(`servergrouplist`);
  }

  async setChannelGroup(channelGroupId: number, channelId: number, clientDbId: number): Promise<void> {
    this.writeLine(`setchannelgroup ${channelGroupId} ${channelId} ${clientDbId}`);
  }

  async addServerGroup(serverGroupId: number, clientDbId: number): Promise<void> {
    this.writeLine(`addservergroup ${serverGroupId} ${clientDbId}`);
  }

  async removeServerGroup(serverGroupId: number, clientDbId: number): Promise<void> {
    this.writeLine(`delservergroup ${serverGroupId} ${clientDbId}`);
  }

  async serverQueryLogin(username: string, password: string): Promise<void> {
    const u = Buffer.from(username, "utf8").toString("base64");
    const p = Buffer.from(password, "utf8").toString("base64");
    this.writeLine(`serverquerylogin ${u} ${p}`);
  }

  async getPermissionOverview(): Promise<void> {
    this.writeLine(`permoverview`);
  }

  async getPermissionCatalog(): Promise<void> {
    this.writeLine(`permissionlist`);
  }

  async getPermList(scope: PermScope, id1: number, id2?: number): Promise<void> {
    const args = id2 !== undefined ? `${scope} ${id1} ${id2}` : `${scope} ${id1}`;
    this.writeLine(`permlist ${args}`);
  }

  /** `negated`/`skip` only apply to the "server" and "client" scopes - the
   *  connector ignores extra trailing args for scopes that don't use them, so
   *  it's safe to always pass through what the caller gave. */
  async addPermission(
    scope: PermScope,
    ids: number[],
    permId: number,
    value: number,
    negated = false,
    skip = false
  ): Promise<void> {
    let args = `${scope} ${ids.join(" ")} ${permId} ${value}`;
    if (scope === "server") args += ` ${negated ? 1 : 0} ${skip ? 1 : 0}`;
    else if (scope === "client") args += ` ${skip ? 1 : 0}`;
    this.writeLine(`permadd ${args}`);
  }

  async removePermission(scope: PermScope, ids: number[], permId: number): Promise<void> {
    this.writeLine(`permdel ${scope} ${ids.join(" ")} ${permId}`);
  }

  async getFileList(channelId: number, path: string): Promise<void> {
    const sanitized = (path || "/").replace(/[\r\n]+/g, " ").trim() || "/";
    this.writeLine(`ftlist ${channelId} ${sanitized}`);
  }

  async createDirectory(channelId: number, dirname: string): Promise<void> {
    const sanitized = dirname.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`ftmkdir ${channelId} ${sanitized}`);
  }

  async deleteFile(channelId: number, name: string): Promise<void> {
    const sanitized = name.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`ftdelete ${channelId} ${sanitized}`);
  }

  async renameFile(channelId: number, oldName: string, newName: string): Promise<void> {
    const sanitize = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
    this.writeLine(`ftrename ${channelId}\t${sanitize(oldName)}\t${sanitize(newName)}`);
  }

  async downloadFile(channelId: number, path: string): Promise<void> {
    const sanitized = path.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`ftdownload ${channelId} ${sanitized}`);
  }

  /** `dataBase64` is the raw file content, base64-encoded - the browser reads
   *  the picked File as a data URL/ArrayBuffer and sends it up already encoded. */
  async uploadFile(channelId: number, path: string, dataBase64: string): Promise<void> {
    const sanitizedPath = path.replace(/[\r\n\t]+/g, " ").trim();
    this.writeLine(`ftupload ${channelId}\t${sanitizedPath}\t${dataBase64}`);
  }

  /** One piece of a chunked upload (see "chunkedUpload" in GATEWAY_FEATURES).
   *  Pieces must arrive in order; offset 0 starts the upload and the piece
   *  that reaches `total` sends it. Keeps every message small, unlike
   *  uploadFile above, which only stays for clients from before the split. */
  async uploadFileChunk(channelId: number, path: string, offset: number, total: number, dataBase64: string): Promise<void> {
    if (![channelId, offset, total].every(Number.isSafeInteger)) return;
    if (typeof dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) return;
    const sanitizedPath = path.replace(/[\r\n\t]+/g, " ").trim();
    this.writeLine(`ftuploadchunk ${channelId}\t${offset}\t${total}\t${sanitizedPath}\t${dataBase64}`);
  }

  async sendChatMessage(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`chat ${sanitized}`);
  }

  async sendServerMessage(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`serverchat ${sanitized}`);
  }

  async sendPrivateMessage(clientId: number, message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`pm ${clientId} ${sanitized}`);
  }

  async sendPoke(clientId: number, message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    this.writeLine(`poke ${clientId} ${sanitized}`);
  }

  async sendAudio(pcmBase64: string): Promise<void> {
    this.writeLine(`audio ${pcmBase64}`);
  }

  /** Pulls a streaming client's stream details; answered with a
   *  `notifystreaminfo` streamEvent carrying the stream id. */
  async requestStreamInfo(clientId: number): Promise<void> {
    this.writeLine(`streaminfo ${clientId}`);
  }

  /** Ask the client publishing a TS6 stream to let us watch. The answer comes
   *  back as a `streamEvent` of type `notifyrespondjoinstreamrequest`, which
   *  carries the SDP offer. */
  async joinStream(streamId: string, clientId: number, message = ""): Promise<void> {
    const id = streamId.replace(/[\s]+/g, "");
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (id) this.writeLine(`streamjoin ${id} ${clientId} ${sanitized}`);
  }

  async leaveStream(streamId: string, clientId: number): Promise<void> {
    const id = streamId.replace(/[\s]+/g, "");
    if (id) this.writeLine(`streamleave ${id} ${clientId}`);
  }

  /** Relays one signaling payload (SDP answer, ICE candidate) to a stream peer.
   *  `payload` is passed straight through - the connector only escapes it for
   *  the TS wire, nobody in this path interprets it. Serializing here rather
   *  than accepting a string keeps literal newlines out of the line-based
   *  stdin protocol. */
  async sendStreamSignal(streamId: string, clientId: number, payload: unknown): Promise<void> {
    const id = streamId.replace(/[\s]+/g, "");
    if (id) this.writeLine(`streamsignal ${id} ${clientId} ${JSON.stringify(payload)}`);
  }

  /** Announces a stream we publish. The server assigns the id and reports it
   *  back as a `notifystreamstarted` streamEvent naming our own client id. */
  async setupStream(options: StreamSetupOptions): Promise<void> {
    const payload = {
      name: options.name.replace(/[\r\n]+/g, " ").trim() || "Stream",
      type: options.type,
      bitrate: options.bitrate,
      accessibility: options.accessibility,
      mode: options.mode,
      viewerLimit: options.viewerLimit,
      audio: options.audio,
    };
    this.writeLine(`streamsetup ${JSON.stringify(payload)}`);
  }

  /** Accepts or refuses a viewer that asked to watch our stream. On accept,
   *  `offer` is our SDP - the publisher offers, which is the mirror of how a
   *  TS6 publisher answered us. JSON-encoded because an SDP is multi-line. */
  async respondJoinStream(
    streamId: string,
    clientId: number,
    accept: boolean,
    offer = "",
    message = "",
  ): Promise<void> {
    const id = streamId.replace(/[\s]+/g, "");
    if (!id) return;
    const payload = {
      id,
      clid: clientId,
      msg: message.replace(/[\r\n]+/g, " ").trim(),
      offer,
      decision: accept ? 1 : 0,
    };
    this.writeLine(`streamrespond ${JSON.stringify(payload)}`);
  }

  async stopStream(streamId: string, reason = ""): Promise<void> {
    const id = streamId.replace(/[\s]+/g, "");
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    if (id) this.writeLine(`streamstop ${id} ${sanitized}`);
  }

  async setAway(away: boolean, message: string): Promise<void> {
    if (away) {
      const sanitized = message.replace(/[\r\n]+/g, " ").trim();
      this.writeLine(`away ${sanitized}`);
    } else {
      this.writeLine("unaway");
    }
  }

  async setInputMuted(muted: boolean): Promise<void> {
    this.writeLine(`muteinput ${muted ? "1" : "0"}`);
  }

  async setOutputMuted(muted: boolean): Promise<void> {
    this.writeLine(`muteoutput ${muted ? "1" : "0"}`);
  }

  /** Playback volume for one speaker, mixed in the connector (1 = unchanged). */
  setClientVolume(clientId: number, volume: number): void {
    if (Number.isInteger(clientId) && Number.isFinite(volume)) this.writeLine(`clientvolume ${clientId} ${volume}`);
  }

  async setNickname(nickname: string): Promise<void> {
    const sanitized = nickname.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.writeLine(`nickname ${sanitized}`);
  }

  /** Incoming whispers: allowed or blocked by default; `exceptions` (client ids) get the opposite. */
  setWhisperPolicy(block: boolean, exceptions: unknown[]): void {
    const ids = exceptions.map(Number).filter(Number.isInteger);
    this.writeLine(`whisperpolicy ${block ? "block" : "allow"};${ids.join(",")}`);
  }

  /** File transfer bandwidth caps in bytes/s, 0 = unlimited. */
  setTransferLimit(up: unknown, down: unknown): void {
    const rate = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
    this.writeLine(`ftlimit ${rate(up)} ${rate(down)}`);
  }

  /** Empty channelIds/clientIds clears whisper mode, returning outgoing
   *  voice to the normal current-channel broadcast. */
  async setWhisperTargets(channelIds: number[], clientIds: number[]): Promise<void> {
    const chans = channelIds.map(Number);
    const clients = clientIds.map(Number);
    if (chans.some((n) => !Number.isFinite(n)) || clients.some((n) => !Number.isFinite(n))) return;
    if (chans.length === 0 && clients.length === 0) {
      this.writeLine("unwhisper");
    } else {
      this.writeLine(`whisper ${chans.join(",")};${clients.join(",")}`);
    }
  }

  async disconnect(message = ""): Promise<void> {
    // childGone means the "exit" event already fired - which happens exactly
    // once, so a .once("exit", ...) listener attached only now (below) would
    // never see it, and this would always fall through to the 3s hard-kill
    // timeout for a process that's already gone. Skip straight past it.
    if (this.child && !this.child.killed && !this.childGone) {
      const child = this.child;
      const sanitized = message.replace(/[\r\n]+/g, " ").trim();
      child.stdin.write(`disconnect ${sanitized}\n`);
      child.stdin.end();
      // Wait for the connector process to actually exit before returning, so a
      // caller that immediately reconnects (index.ts's "connect" handler) never
      // spawns a replacement while this one is still shutting down - two
      // connector processes would otherwise briefly hold the same audio/socket
      // resources. Fall back to a hard kill if it doesn't exit on its own.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill();
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.listeners.clear();
  }
}
