export {
  HadesAccountService,
  AuthError,
  checkPassword,
  isValidEmail,
  supersedes,
} from "./service";
export type {
  AuthErrorCode,
  AuthSession,
  HadesAccountServiceOptions,
  HadesUser,
} from "./service";

export {
  InMemoryAccountStore,
  hashPassword,
  newAccountId,
  normaliseEmail,
  verifyPassword,
} from "./store";
export type {
  AccountRecord,
  AccountStore,
  SyncEnvelope,
  SyncRecordInput,
  SyncRecordRow,
} from "./store";

export {
  getHadesAccountService,
  setHadesAccountService,
  handleRefresh,
  handleSignIn,
  handleSignOut,
  handleSignUp,
  handleSync,
} from "./handlers";
