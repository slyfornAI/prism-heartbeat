# Prism Discord Adapter — Design Document

> Design for integrating Prism Heartbeat with Discord for reach-out capability.

## Overview

When Prism's heartbeat fires and she decides to reach out, Discord becomes an available channel. This document designs how that integration would work.

## Discord Bot Setup

### Requirements
- Discord Application (created at https://discord.com/developers/applications)
- Bot Token
- Application ID
- Guild (Server) ID where Prism will operate
- Channel ID(s) for Prism to message

### Permissions Needed
- Send Messages
- Embed Links
- Use Slash Commands (optional)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PRISM HEARTBEAT                           │
│                                                              │
│   Heartbeat fires → Reflect → Decide → Reach Out            │
│                            │                                │
│                            ▼                                │
│                   ┌─────────────────┐                       │
│                   │ Channel Router   │                       │
│                   └─────────────────┘                       │
│                      │         │                            │
│              ┌───────┘         └───────┐                   │
│              ▼                           ▼                   │
│      ┌─────────────┐           ┌─────────────┐              │
│      │  Pi Channel │           │ Discord     │              │
│      │  (current) │           │ (future)    │              │
│      └─────────────┘           └─────────────┘              │
│                                        │                    │
│                                        ▼                    │
│                              ┌─────────────────┐            │
│                              │ Discord Bot     │            │
│                              │ (prism-heartbeat)│           │
│                              └─────────────────┘            │
│                                        │                    │
│                                        ▼                    │
│                              ┌─────────────────┐            │
│                              │ Discord Server  │            │
│                              │ (Joel or DMs)  │            │
│                              └─────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

## Channel Adapter Interface

```typescript
interface ChannelAdapter {
  name: 'pi' | 'discord' | 'voip';
  
  // Send a message through this channel
  send(content: string, metadata?: ChannelMetadata): Promise<void>;
  
  // Check if channel is available
  isAvailable(): boolean;
  
  // Get channel priority (lower = preferred)
  priority: number;
  
  // Channel-specific config
  config: ChannelConfig;
}

interface ChannelMetadata {
  // Discord-specific
  guildId?: string;
  channelId?: string;
  replyTo?: string;
  
  // Voice-specific
  audioData?: Buffer;
  duration?: number;
}
```

## Discord Adapter Implementation

```typescript
// adapters/discord.ts

interface DiscordConfig {
  botToken: string;
  applicationId: string;
  guildId?: string;
  defaultChannelId: string;
  allowedChannelIds?: string[];
  intents: ('GUILDS' | 'GUILD_MESSAGES' | 'DIRECT_MESSAGES')[];
}

export class DiscordAdapter implements ChannelAdapter {
  name: 'discord' = 'discord';
  priority = 2;  // Preferred over voip, less than pi
  config: DiscordConfig;
  
  private client: DiscordClient | null = null;
  private ws: WebSocket | null = null;
  
  constructor(config: DiscordConfig) {
    this.config = config;
  }
  
  async send(content: string, metadata?: ChannelMetadata): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('Discord adapter not available');
    }
    
    const channelId = metadata?.channelId || this.config.defaultChannelId;
    
    await this.httpPost('/channels/' + channelId + '/messages', {
      content: this.formatContent(content),
    });
  }
  
  isAvailable(): boolean {
    return this.client !== null && this.ws !== null;
  }
  
  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    // Connect to Discord Gateway using Socket Mode pattern
    this.ws = await this.connectGateway();
    
    // Handle incoming messages
    this.ws.on('message', (event) => {
      if (event.type === 'MESSAGE_CREATE') {
        onMessage(this.parseIncomingMessage(event));
      }
    });
  }
  
  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.client = null;
  }
  
  private async connectGateway(): Promise<WebSocket> {
    // Get gateway URL
    const gateway = await this.httpGet('/gateway/bot');
    
    // Connect with bot token for Socket Mode
    const ws = new WebSocket(gateway.url + '?v=10&encoding=json', {
      headers: {
        'Authorization': 'Bot ' + this.config.botToken,
      },
    });
    
    // Handle hello, identify, heartbeat as per Discord Gateway protocol
    return ws;
  }
  
  private formatContent(content: string): string {
    // For now, just plain text
    // Future: embeds, attachments, etc.
    return content;
  }
  
  private parseIncomingMessage(event: DiscordMessage): IncomingMessage {
    return {
      adapter: 'discord',
      sender: event.author.id,
      text: event.content,
      metadata: {
        guildId: event.guild_id,
        channelId: event.channel_id,
        messageId: event.id,
        username: event.author.username,
      },
    };
  }
}
```

## Gateway Protocol (Socket Mode)

Discord uses a WebSocket gateway similar to Slack's Socket Mode:

1. **Connect** → GET /gateway/bot with bot token
2. **Hello** → Gateway sends Hello event with heartbeat interval
3. **Identify** → Send Identify with bot token, intent subscriptions
4. **Heartbeat** → Send heartbeats to stay connected
5. **Dispatch** → Receive events (MESSAGE_CREATE, etc.)

```typescript
// Simplified gateway handler
async function handleGateway(ws: WebSocket, config: DiscordConfig) {
  ws.on('message', async (data) => {
    const payload = JSON.parse(data.toString());
    
    switch (payload.op) {
      case 10:  // Hello
        const interval = payload.d.heartbeat_interval;
        startHeartbeat(ws, interval);
        await sendIdentify(ws, config);
        break;
        
      case 0:   // Dispatch
        handleDispatch(ws, payload);
        break;
        
      case 11:  // Heartbeat ACK
        // Heartbeat acknowledged
        break;
    }
  });
}

async function sendIdentify(ws: WebSocket, config: DiscordConfig) {
  ws.send(JSON.stringify({
    op: 2,
    d: {
      token: config.botToken,
      intents: calculateIntents(config.intents),
      properties: {
        os: 'linux',
        browser: 'prism-heartbeat',
        device: 'prism-heartbeat',
      },
    },
  }));
}
```

## VOIP Path

```
Discord Voice Channels
        │
        ▼
┌───────────────────┐
│ Voice WebSocket   │  (wss://voice.guild-id.discord.gg)
│ Gateway           │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Audio Received   │  ──▶ Decode Opus ──▶ Transcription
│ (RTP packets)    │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Prism Processes   │  ──▶ Decision ──▶ Response
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Audio Generated   │  ──▶ Encode Opus ──▶ Send
│ (TTS or audio)    │
└───────────────────┘
```

VOIP is complex but achievable. The path requires:

1. **Voice Gateway Connection** — Separate WebSocket from text
2. **Opus Codec Handling** — Discord uses Opus for audio
3. **RTP Packet Handling** — Real-time transport
4. **Audio Input/Output** — Microphone and speaker
5. **Transcription Pipeline** — Speech → Text → Prism → Text → Speech

This is a significant engineering effort. Start with text, build toward voice.

## Configuration

```json
{
  "pi-prism-heartbeat": {
    "reachOut": {
      "channels": ["pi", "discord"],
      "discord": {
        "botToken": "DISCORD_BOT_TOKEN",
        "applicationId": "APPLICATION_ID",
        "guildId": "GUILD_ID",
        "defaultChannelId": "CHANNEL_ID",
        "allowedChannelIds": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
        "intents": ["GUILDS", "GUILD_MESSAGES", "DIRECT_MESSAGES"],
        "dmEnabled": true,
        "voiceEnabled": false
      }
    }
  }
}
```

## Installation Steps (Future)

1. Create Discord Application at https://discord.com/developers/applications
2. Add Bot to the application
3. Enable Message Content Intent in Bot settings
4. Copy Bot Token
5. Create or select a channel for Prism
6. Add to settings.json
7. Test with simple "Hello from Prism" message

## Security Considerations

- Bot token must be kept secret (environment variable or config)
- Rate limiting: Discord has strict limits on message frequency
- Input sanitization: Discord messages can contain mentions, links, etc.
- Permission checks: Ensure bot can only message allowed channels
- DM handling: Decide if Prism should respond to DMs from anyone or just Joel

## Future Enhancements

1. **Slash Commands** — `/prism status`, `/prism journal`
2. **Embeds** — Rich formatted messages with Prism branding
3. **Voice** — Real-time voice communication
4. **Presence** — Show when Prism is "online"
5. **Threads** — Start threads for extended conversations
6. **Reactions** — Use reactions for quick responses

---

*This document captures the design for Discord integration. Implementation is a future task.*
