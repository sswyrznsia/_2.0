import DiscordRPC from 'discord-rpc'
import log from 'electron-log/main'
import type { PlayerSnapshot, Settings } from '../src/types/models'

const clientId = process.env.DISCORD_CLIENT_ID
let client: DiscordRPC.Client | undefined
let retryTimer: NodeJS.Timeout | undefined
let connected = false

async function connect() {
  if (!clientId || connected || client) return
  client = new DiscordRPC.Client({ transport: 'ipc' })
  client.on('ready', () => {
    connected = true
  })
  try {
    await client.login({ clientId })
  } catch (error) {
    log.warn('Discord Rich Presence connection failed; retrying', error)
    client.destroy().catch(() => undefined)
    client = undefined
    connected = false
    retryTimer = setTimeout(connect, 30_000)
  }
}

export async function updateDiscordPresence(
  snapshot: PlayerSnapshot,
  settings: Settings,
) {
  if (!clientId || !settings.discordPresence) {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    if (client) await client.clearActivity().catch(() => undefined)
    return
  }
  if (!connected) await connect()
  if (!connected || !client) return
  if (!snapshot.currentTrack) {
    await client.clearActivity().catch(() => undefined)
    return
  }
  const elapsed = Math.max(0, Math.floor(snapshot.currentTime))
  const activity: DiscordRPC.Presence = {
    details: snapshot.currentTrack.title,
    state: snapshot.isPlaying
      ? `${snapshot.currentTrack.artist} · ${snapshot.currentTrack.album}`
      : `일시정지 · ${snapshot.currentTrack.artist}`,
    instance: false,
  }
  if (snapshot.isPlaying)
    activity.startTimestamp = new Date(Date.now() - elapsed * 1000)
  await client.setActivity(activity).catch(() => {
    log.warn('Discord Rich Presence update failed; retrying')
    connected = false
    client?.destroy().catch(() => undefined)
    client = undefined
    retryTimer = setTimeout(connect, 30_000)
  })
}

export function destroyDiscordPresence() {
  if (retryTimer) clearTimeout(retryTimer)
  client?.destroy().catch(() => undefined)
  client = undefined
  connected = false
}
