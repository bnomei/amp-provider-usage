import type { PluginAPI } from '@ampcode/plugin'
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Provider = 'amp' | 'codex' | 'grok'

const ALL_PROVIDERS: Provider[] = ['amp', 'codex', 'grok']
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const MAX_AUTH_BYTES = 1024 * 1024
const MAX_HTTP_BYTES = 1024 * 1024
const MAX_PROCESS_BYTES = 64 * 1024
const MAX_OUTPUT_CHARS = 16 * 1024

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function run(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: { ...process.env, NO_COLOR: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		let bytes = 0
		let settled = false
		let closed = false
		let killTimer: ReturnType<typeof setTimeout> | undefined

		const finish = (fn: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			fn()
		}
		const terminate = (message: string) => {
			if (settled) return
			child.stdout.removeAllListeners('data')
			child.stderr.removeAllListeners('data')
			child.kill('SIGTERM')
			killTimer = setTimeout(() => {
				if (!closed) child.kill('SIGKILL')
			}, 1_000)
			finish(() => reject(new Error(message)))
		}
		const timer = setTimeout(() => terminate(`${command} timed out`), timeoutMs)

		const append = (target: 'stdout' | 'stderr', chunk: string) => {
			bytes += Buffer.byteLength(chunk)
			if (bytes > MAX_PROCESS_BYTES) {
				terminate(`${command} output exceeded limit`)
				return
			}
			if (target === 'stdout') stdout += chunk
			else stderr += chunk
		}
		child.stdout.setEncoding('utf8').on('data', chunk => append('stdout', chunk))
		child.stderr.setEncoding('utf8').on('data', chunk => append('stderr', chunk))
		child.once('error', () => finish(() => reject(new Error(`could not start ${command}`))))
		child.once('close', code => {
			closed = true
			if (killTimer) clearTimeout(killTimer)
			finish(() => {
				const output = (stdout.trim() || stderr.trim()).replace(ANSI, '')
				if (code === 0) resolve(output)
				else reject(new Error(`${command} exited with status ${code ?? 'unknown'}`))
			})
		})
	})
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > MAX_HTTP_BYTES) throw new Error('response exceeded limit')
	if (!response.body) return new Uint8Array()

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > MAX_HTTP_BYTES) {
			await reader.cancel()
			throw new Error('response exceeded limit')
		}
		chunks.push(value)
	}

	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

async function fetchJSON(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 12_000)
	try {
		const response = await fetch(url, {
			headers,
			redirect: 'error',
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		return JSON.parse(new TextDecoder().decode(await readBoundedBody(response)))
	} finally {
		clearTimeout(timer)
	}
}

async function readAuthFile(path: string, provider: 'codex' | 'grok'): Promise<Record<string, unknown>> {
	try {
		const info = await stat(path)
		if (!info.isFile() || info.size > MAX_AUTH_BYTES) throw new Error('invalid credential file')
		return asRecord(JSON.parse(await readFile(path, 'utf8'))) ?? {}
	} catch {
		throw new Error(`credentials unavailable; run \`${provider} login\``)
	}
}

function safeLabel(value: unknown, fallback = ''): string {
	const label = String(value ?? '')
		.replace(ANSI, '')
		.replace(/[\x00-\x1f\x7f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
	return label || fallback
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function asNumber(value: unknown): number | undefined {
	const number = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(number) ? number : undefined
}

function formatReset(value: unknown): string {
	const seconds = asNumber(value)
	if (!seconds) return ''
	const date = new Date(seconds * 1000)
	if (!Number.isFinite(date.getTime())) return ''
	const milliseconds = date.getTime() - Date.now()
	if (milliseconds <= 0) return ` · reset ${date.toLocaleString()}`
	const minutes = Math.ceil(milliseconds / 60_000)
	const days = Math.floor(minutes / 1440)
	const hours = Math.floor((minutes % 1440) / 60)
	const remainder = minutes % 60
	const relative = days > 0 ? `${days}d${hours ? ` ${hours}h` : ''}` : hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`
	return ` · resets in ${relative}`
}

function formatWindow(label: string, value: unknown): string | undefined {
	const window = asRecord(value)
	const used = asNumber(window?.used_percent)
	if (used === undefined) return undefined
	return `${label}: ${Math.max(0, 100 - used).toFixed(0)}% remaining${formatReset(window?.reset_at)}`
}

function windowLabel(value: unknown, fallback: string): string {
	const seconds = asNumber(asRecord(value)?.limit_window_seconds)
	if (!seconds) return fallback
	if (seconds === 604_800) return 'Weekly'
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
	return fallback
}

async function codexUsage(): Promise<string> {
	const home = process.env.CODEX_HOME || join(homedir(), '.codex')
	const auth = await readAuthFile(join(home, 'auth.json'), 'codex')
	const tokens = asRecord(auth?.tokens)
	const token = tokens?.access_token ?? tokens?.accessToken
	const accountID = tokens?.account_id ?? tokens?.accountId
	if (typeof token !== 'string' || !token) throw new Error('not logged in; run `codex login`')

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/json',
		'User-Agent': 'amp-provider-usage',
	}
	if (typeof accountID === 'string' && accountID) headers['ChatGPT-Account-Id'] = accountID

	let data: Record<string, unknown>
	try {
		data = asRecord(
			await fetchJSON('https://chatgpt.com/backend-api/wham/usage', headers),
		) ?? { }
	} catch (error) {
		throw new Error(`${errorMessage(error)}; run \`codex login\` if the token expired`)
	}

	const rateLimit = asRecord(data.rate_limit)
	const primary = rateLimit?.primary_window
	const secondary = rateLimit?.secondary_window
	const lines = [
		formatWindow(windowLabel(primary, 'Primary'), primary),
		formatWindow(windowLabel(secondary, 'Secondary'), secondary),
	].filter((line): line is string => Boolean(line))

	const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 20) : []
	for (const item of additional) {
		const limit = asRecord(item)
		const windows = asRecord(limit?.rate_limit)
		const name = safeLabel(limit?.limit_name || limit?.metered_feature, 'Additional').replace(/-Codex-/i, ' ')
		if (/\bSpark\b/i.test(name)) continue
		const primary = formatWindow(name, windows?.primary_window)
		const secondary = formatWindow(`${name} weekly`, windows?.secondary_window)
		if (primary) lines.push(primary)
		if (secondary) lines.push(secondary)
	}

	const credits = asRecord(data.credits)
	if (credits?.unlimited === true) lines.push('Credits: unlimited')
	else if (credits?.balance !== undefined) {
		const balance = asNumber(credits.balance)
		if (balance !== undefined) lines.push(`Credits: ${balance.toFixed(2)}`)
	}
	if (!lines.length) throw new Error('usage response had no recognized limits')

	const planType = safeLabel(data.plan_type)
	const plan = planType ? ` · ${planType}` : ''
	return `Codex${plan}\n${lines.map(line => `  ${line}`).join('\n')}`
}

interface ProtoScan {
	fixed32: Array<{ path: number[]; value: number; order: number }>
	varints: Array<{ path: number[]; value: bigint }>
}

function readVarint(bytes: Uint8Array, start: number) {
	let value = 0n
	let shift = 0n
	let index = start
	while (index < bytes.length && shift < 64n) {
		const byte = bytes[index++]
		value |= BigInt(byte & 0x7f) << shift
		if ((byte & 0x80) === 0) return { value, index }
		shift += 7n
	}
	return undefined
}

function scanProto(bytes: Uint8Array, depth = 0, parent: number[] = [], scan?: ProtoScan): ProtoScan {
	const result = scan ?? { fixed32: [], varints: [] }
	let index = 0
	while (index < bytes.length) {
		const fieldStart = index
		const key = readVarint(bytes, index)
		if (!key || key.value === 0n) {
			index = fieldStart + 1
			continue
		}
		index = key.index
		const field = Number(key.value >> 3n)
		const wire = Number(key.value & 7n)
		const path = [...parent, field]

		if (wire === 0) {
			const value = readVarint(bytes, index)
			if (!value) index = fieldStart + 1
			else {
				result.varints.push({ path, value: value.value })
				index = value.index
			}
		} else if (wire === 1) {
			if (index + 8 > bytes.length) break
			index += 8
		} else if (wire === 2) {
			const length = readVarint(bytes, index)
			if (!length || length.value > BigInt(bytes.length - length.index)) {
				index = fieldStart + 1
				continue
			}
			const end = length.index + Number(length.value)
			if (depth < 4) scanProto(bytes.subarray(length.index, end), depth + 1, path, result)
			index = end
		} else if (wire === 5) {
			if (index + 4 > bytes.length) break
			const value = new DataView(bytes.buffer, bytes.byteOffset + index, 4).getFloat32(0, true)
			result.fixed32.push({ path, value, order: result.fixed32.length })
			index += 4
		} else index = fieldStart + 1
	}
	return result
}

function grpcPayloads(body: Uint8Array): Uint8Array[] {
	const payloads: Uint8Array[] = []
	let index = 0
	while (index < body.length) {
		if (index + 5 > body.length) return []
		const flags = body[index]
		const length = new DataView(body.buffer, body.byteOffset + index + 1, 4).getUint32(0)
		const end = index + 5 + length
		if (end > body.length) return []
		if ((flags & 0x80) === 0) payloads.push(body.subarray(index + 5, end))
		index = end
	}
	return payloads
}

function grpcTrailerStatus(body: Uint8Array): number | undefined {
	let index = 0
	while (index + 5 <= body.length) {
		const flags = body[index]
		const length = new DataView(body.buffer, body.byteOffset + index + 1, 4).getUint32(0)
		const end = index + 5 + length
		if (end > body.length) break
		if ((flags & 0x80) !== 0) {
			const trailer = new TextDecoder().decode(body.subarray(index + 5, end))
			const status = trailer.match(/^grpc-status:\s*(\d+)\s*$/im)
			if (status) return Number(status[1])
		}
		index = end
	}
	return undefined
}

function parseGrokBilling(body: Uint8Array): { used: number; reset?: number } {
	let payloads = grpcPayloads(body)
	const firstWire = body.length ? body[0] & 7 : -1
	if (!payloads.length && body.length && body[0] >> 3 > 0 && [0, 1, 2, 5].includes(firstWire)) {
		payloads = [body]
	}
	const scan: ProtoScan = { fixed32: [], varints: [] }
	for (const payload of payloads) scanProto(payload, 0, [], scan)

	const percentages = scan.fixed32
		.filter(field => field.path.at(-1) === 1 && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
		.sort((a, b) => a.path.length - b.path.length || a.order - b.order)
	const now = Math.floor(Date.now() / 1000)
	const resets = scan.varints
		.filter(field => field.value >= 1_700_000_000n && field.value <= 2_100_000_000n && Number(field.value) > now)
		.sort((a, b) => {
			const aPreferred = a.path.join('.') === '1.5.1' ? 0 : 1
			const bPreferred = b.path.join('.') === '1.5.1' ? 0 : 1
			return aPreferred - bPreferred || Number(a.value - b.value)
		})
	const hasPeriod = scan.varints.some(field =>
		field.path[0] === 1 && (field.path[1] === 6 || (field.path.join('.') === '1.8.1' && [1n, 2n].includes(field.value))),
	)
	const used = percentages[0]?.value ?? (scan.fixed32.length === 0 && resets.length > 0 && hasPeriod ? 0 : undefined)
	if (used === undefined) throw new Error('could not parse billing response')
	return { used, reset: resets[0] ? Number(resets[0].value) : undefined }
}

async function grokUsage(): Promise<string> {
	const home = process.env.GROK_HOME || join(homedir(), '.grok')
	const auth = await readAuthFile(join(home, 'auth.json'), 'grok')
	const entries = Object.entries(auth ?? {})
	const record = asRecord(entries.find(([scope]) => scope.startsWith('https://auth.x.ai::'))?.[1] ?? entries[0]?.[1])
	const token = record?.key
	if (typeof token !== 'string' || !token) throw new Error('not logged in; run `grok login`')

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 12_000)
	try {
		const response = await fetch('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				Origin: 'https://grok.com',
				Referer: 'https://grok.com/?_s=usage',
				Accept: '*/*',
				'Content-Type': 'application/grpc-web+proto',
				'x-grpc-web': '1',
				'x-user-agent': 'connect-es/2.1.1',
				'User-Agent': 'amp-provider-usage',
			},
			body: new Uint8Array(5),
			redirect: 'error',
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const grpcStatus = response.headers.get('grpc-status')
		if (grpcStatus && grpcStatus !== '0') throw new Error(`gRPC status ${grpcStatus}`)
		const body = await readBoundedBody(response)
		const trailerStatus = grpcTrailerStatus(body)
		if (trailerStatus !== undefined && trailerStatus !== 0) throw new Error(`gRPC status ${trailerStatus}`)
		const billing = parseGrokBilling(body)
		return `Grok\n  Monthly: ${Math.max(0, 100 - billing.used).toFixed(0)}% remaining${formatReset(billing.reset)}`
	} catch (error) {
		throw new Error(`${errorMessage(error)}; run \`grok login\` if the token expired`)
	} finally {
		clearTimeout(timer)
	}
}

async function ampUsage(): Promise<string> {
	const output = await run('amp', ['usage'])
	if (!output) throw new Error('`amp usage` returned no output')

	const lines = output.split('\n').map(line => line.trim()).filter(Boolean)
	const subscription = lines
		.map(line => line.match(/^Subscription\s+(.+?):\s+([\d.]+)%\s+other usage and\s+([\d.]+)%\s+orb usage remaining\s+-\s+resets upon renewal in\s+(\d+)\s+days?$/i))
		.find(match => match)
	const credits = lines
		.map(line => line.match(/^Individual credits:\s+(\$?[\d,.]+)\s+remaining/i))
		.find(match => match)

	if (subscription) {
		const plan = safeLabel(subscription[1], 'Subscription')
		const details = [
			`Remaining: Agents ${subscription[2]}% · Orb ${subscription[3]}%`,
			`Renews in ${subscription[4]}d${credits ? ` · Credits: ${credits[1]}` : ''}`,
		]
		return `Amp · ${plan}\n${details.map(line => `  ${line}`).join('\n')}`
	}

	const details: string[] = []
	const freeMoney = lines
		.map(line => line.match(/^Amp Free:\s+(\$?[\d,.]+)\/(\$?[\d,.]+)\s+remaining\s+\(replenishes\s+\+(\$?[\d,.]+)\/hour\)$/i))
		.find(match => match)
	const freePercent = lines
		.map(line => line.match(/^Amp Free:\s+([\d.]+)%\s+remaining today\s+\(resets daily\)$/i))
		.find(match => match)
	if (freeMoney) details.push(`Free: ${freeMoney[1]}/${freeMoney[2]} remaining · +${freeMoney[3]}/h`)
	else if (freePercent) details.push(`Free: ${freePercent[1]}% remaining · resets daily`)
	if (credits) details.push(`Credits: ${credits[1]}`)
	for (const line of lines.slice(0, 20)) {
		const workspace = line.match(/^Workspace\s+(.+?):\s+(\$?[\d,.]+)\s+remaining$/i)
		if (workspace) details.push(`${safeLabel(workspace[1], 'Workspace')}: ${workspace[2]}`)
	}
	if (!details.length) throw new Error('`amp usage` output was not recognized')
	return `Amp\n${details.map(line => `  ${line}`).join('\n')}`
}

export async function gatherProviderUsage(providers: Provider[] = ALL_PROVIDERS): Promise<string> {
	const fetchers: Record<Provider, () => Promise<string>> = {
		amp: ampUsage,
		codex: codexUsage,
		grok: grokUsage,
	}
	const results = await Promise.all(
		providers.map(async provider => {
			try {
				return await fetchers[provider]()
			} catch (error) {
				return `${provider[0].toUpperCase()}${provider.slice(1)}\n  unavailable: ${errorMessage(error)}`
			}
		}),
	)
	const output = results.join('\n\n')
	return output.length <= MAX_OUTPUT_CHARS
		? output
		: `${output.slice(0, MAX_OUTPUT_CHARS)}\n\nOutput truncated.`
}

export default function (amp: PluginAPI) {
	const gatherLocalUsage = () => amp.system.executor.kind === 'remote'
		? Promise.resolve('Provider usage requires a local Amp executor.')
		: gatherProviderUsage()

	amp.registerCommand(
		'provider-usage',
		{
			title: 'Refresh provider usage',
			category: 'Usage',
			description: 'Show Amp, Codex subscription, and Grok subscription usage',
		},
		async ctx => {
			await ctx.ui.confirm({
				title: 'Provider usage',
				message: await gatherLocalUsage(),
				confirmButtonText: 'Close',
			})
		},
	)

	amp.registerTool({
		name: 'provider_usage',
		description: 'Get current Amp, OpenAI Codex subscription, and xAI Grok subscription usage or remaining quota.',
		inputSchema: {
			type: 'object',
			properties: {
				providers: {
					type: 'array',
					items: { type: 'string', enum: ALL_PROVIDERS },
					description: 'Providers to query; defaults to amp, codex, and grok.',
				},
			},
		},
		async execute(input) {
			if (amp.system.executor.kind === 'remote') return 'Provider usage requires a local Amp executor.'
			const requested = Array.isArray(input.providers)
				? input.providers.filter((provider): provider is Provider => ALL_PROVIDERS.includes(provider as Provider))
				: ALL_PROVIDERS
			return gatherProviderUsage(requested.length ? requested : ALL_PROVIDERS)
		},
	})
}
