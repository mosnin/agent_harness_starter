# workspace-isolation

Input {records,scope,id}. Return deep copy only for exact id/profile/sessionId/root match, otherwise null. Scope root must be absolute normalized POSIX path (no empty/dot/dotdot segments or trailing slash except /); invalid scope throws. Prefix/partial matches cannot grant access.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
