import {
	PostgresDeliveryRepository,
	createAgentFeedPool,
	type HistoricalDeliveryMaterializationResult,
} from "@agent-feed/persistence-postgres";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

export class HistoricalMaterializationCliError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "HistoricalMaterializationCliError";
		this.code = code;
	}
}

export interface HistoricalMaterializationArguments {
	databaseUrl?: string;
	tenantId?: string;
	consumerId?: string;
	subscriptionId?: string;
	eventIds: string[];
	runIds: string[];
	help: boolean;
}

function valueAt(args: readonly string[], index: number, name: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--"))
		throw new HistoricalMaterializationCliError(`missing_${name}`);
	return value;
}

function exactId(value: string, name: string): string {
	if (!ID.test(value))
		throw new HistoricalMaterializationCliError(`invalid_${name}`);
	return value;
}

export function parseHistoricalMaterializationArguments(
	args: readonly string[],
): HistoricalMaterializationArguments {
	const result: HistoricalMaterializationArguments = {
		eventIds: [],
		runIds: [],
		help: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			result.help = true;
			continue;
		}
		if (argument === undefined || !argument.startsWith("--"))
			throw new HistoricalMaterializationCliError("invalid_argument");
		const name = argument.slice(2).replaceAll("-", "_");
		const value = valueAt(args, index, name);
		index += 1;
		if (name === "database_url") result.databaseUrl = value;
		else if (name === "tenant_id") result.tenantId = exactId(value, name);
		else if (name === "consumer_id") result.consumerId = exactId(value, name);
		else if (name === "subscription_id")
			result.subscriptionId = exactId(value, name);
		else if (name === "event_id") result.eventIds.push(exactId(value, name));
		else if (name === "run_id") result.runIds.push(exactId(value, name));
		else throw new HistoricalMaterializationCliError(`unknown_${name}`);
	}
	return result;
}

export function historicalMaterializationUsage(): string {
	return `Agent Feed bounded historical materialization

Usage:
  npm run materialize-history -- [--database-url URL]
    --tenant-id ID --consumer-id ID --subscription-id UUID
    --event-id ID [--event-id ID ...]
    --run-id ID [--run-id ID ...]

Both exact sets are mandatory. Event IDs are the only selection key; run IDs
are an exact cross-check. No date, position, stream, or all-history wildcard is
supported. The command is idempotent and prints counts only.`;
}

export interface HistoricalMaterializationDependencies {
	materialize?: (
		input: Parameters<
			PostgresDeliveryRepository["materializeHistoricalDeliveries"]
		>[0],
	) => Promise<HistoricalDeliveryMaterializationResult>;
}

export async function runHistoricalMaterialization(
	parsed: HistoricalMaterializationArguments,
	environment: NodeJS.ProcessEnv = process.env,
	dependencies: HistoricalMaterializationDependencies = {},
): Promise<HistoricalDeliveryMaterializationResult> {
	const databaseUrl =
		parsed.databaseUrl ??
		environment.AGENT_FEED_DATABASE_URL ??
		environment.DATABASE_URL;
	if (!databaseUrl)
		throw new HistoricalMaterializationCliError("database_url_required");
	if (!parsed.tenantId)
		throw new HistoricalMaterializationCliError("tenant_id_required");
	if (!parsed.consumerId)
		throw new HistoricalMaterializationCliError("consumer_id_required");
	if (!parsed.subscriptionId)
		throw new HistoricalMaterializationCliError("subscription_id_required");
	if (parsed.eventIds.length < 1)
		throw new HistoricalMaterializationCliError("event_ids_required");
	if (parsed.runIds.length < 1)
		throw new HistoricalMaterializationCliError("run_ids_required");

	const input = {
		tenantId: parsed.tenantId,
		consumerId: parsed.consumerId,
		subscriptionId: parsed.subscriptionId,
		eventIds: parsed.eventIds,
		runIds: parsed.runIds,
	};
	if (dependencies.materialize) return dependencies.materialize(input);

	const pool = createAgentFeedPool(databaseUrl);
	try {
		return await new PostgresDeliveryRepository(
			pool,
		).materializeHistoricalDeliveries(input);
	} finally {
		await pool.end();
	}
}

async function main(): Promise<void> {
	try {
		const parsed = parseHistoricalMaterializationArguments(
			process.argv.slice(2),
		);
		if (parsed.help) {
			process.stdout.write(`${historicalMaterializationUsage()}\n`);
			return;
		}
		const result = await runHistoricalMaterialization(parsed);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		const code =
			error instanceof HistoricalMaterializationCliError
				? error.code
				: error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
					? error.message
					: "historical_materialization_failed";
		process.stderr.write(`${code}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
