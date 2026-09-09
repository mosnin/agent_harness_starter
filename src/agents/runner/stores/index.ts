/**
 * Durable `RunnerStore` adapters. `InMemoryRunnerStore` stays the default; install one of these
 * with `setRunnerStore()` before the first pairing when more than one instance is serving.
 */

export {
	createRedisRunnerStore,
	fromIoRedis,
	fromUpstashRedis,
} from "./redis-runner-store";
export type {
	IoRedisLikeClient,
	RedisRunnerStoreOptions,
	RunnerRedisClient,
	RunnerRedisSetOptions,
	UpstashRedisLikeClient,
} from "./redis-runner-store";
