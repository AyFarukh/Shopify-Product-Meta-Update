// In-process job execution is used for local/single-instance development.
// Production deployments should swap this module for a durable queue without changing route contracts.
export const jobRuntime = { mode: 'in-process' as const };
