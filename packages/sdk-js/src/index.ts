export * from '../../core/src/contracts/types.js';
export {
  validateRequestFile,
  validateExecutionResult,
  validateExecutionBatchResult,
  normalizeRequestHeaders,
} from '../../core/src/contracts/validation.js';
export {
  createVariableSnapshot,
  compareVariableFileNames,
  isVariablesFileName,
  validateVariablesFile,
  planVariableFileActivation,
} from '../../core/src/variables/variables.js';
export {
  loadVariableSnapshot,
  setVariableFileEnabled,
  VariableFileError,
} from '../../runtime-node/src/variable-files.js';
export {
  interpolateRequest,
  TemplateResolver,
  TemplateError,
  PLACEHOLDER,
} from '../../core/src/templates/interpolation.js';
export type {
  TemplateOptions,
  TemplateResolution,
  TemplateErrorCode,
} from '../../core/src/templates/interpolation.js';
export {
  findPlaceholders,
  hoverVariable,
  completeAt,
  diagnosePlaceholders,
} from '../../language-service/src/language-service.js';
export type {
  PlaceholderSpan,
  VariableHover,
  Completion,
  LanguageDiagnostic,
} from '../../language-service/src/language-service.js';
export {
  checkHttpTarget,
  isPrivateHostname,
  HttpPolicyError,
  approveProtectedExecution,
} from '../../core/src/security/policies.js';
export type {
  HttpNetworkPolicy,
  ApprovalAdapter,
  ApprovalRequest,
} from '../../core/src/security/policies.js';
export {
  fetchHttpRequest,
  ExecutionSession,
  HttpExecutionError,
} from '../../runtime-node/src/http/fetch-transport.js';
export type { FetchOptions } from '../../runtime-node/src/http/fetch-transport.js';
export { executeRequestFile } from './execution.js';
export type { ExecuteRequestOptions } from './execution.js';
export { executeLoop } from './loop-execution.js';
export type { LoopOptions, LoopEvent, LoopExecution } from './loop-execution.js';
export { readLoopItems, LoopSourceError } from '../../runtime-node/src/execution/loop-data.js';
export {
  oauthMetadataCandidates,
  parseOAuthMetadata,
  normalizeOAuthIssuer,
  createOAuthDefinition,
  assertOAuthVariableName,
  OAuthConfigError,
} from '../../core/src/oauth/discovery.js';
export type { OAuthDefinition, OAuthDiscoveryPlan } from '../../core/src/oauth/discovery.js';
export { discoverOAuthIssuer, OAuthDiscoveryError } from '../../runtime-node/src/oauth/discovery.js';
export type { OAuthDiscoveryOptions } from '../../runtime-node/src/oauth/discovery.js';
export { saveOAuthVariable, OAuthSaveError } from '../../runtime-node/src/oauth/variable-writer.js';
export type { OAuthSaveOptions } from '../../runtime-node/src/oauth/variable-writer.js';
export { importCurl } from '../../importers/src/curl.js';
export { importOpenApi } from '../../importers/src/openapi.js';
export { ImportError, safeRequestFilename, uniquifyFileNames } from '../../importers/src/import-plan.js';
export type {
  ImportPlan,
  ImportedRequest,
  ImportWarning,
  ImportFormat,
} from '../../importers/src/import-plan.js';
export { applyImportPlan } from '../../runtime-node/src/importers/apply.js';
export { preparePKCEAuthorization, validateOAuthRedirectUri } from '../../core/src/oauth/pkce.js';
export type { PKCEAuthorization } from '../../core/src/oauth/pkce.js';
export { exchangeAuthorizationCode, OAuthTokenError } from '../../runtime-node/src/oauth/token-exchange.js';
export type {
  OAuthCredential,
  OAuthCredentialVault,
  OAuthAuthorizationHost,
} from '../../runtime-node/src/oauth/token-exchange.js';

export { prepareRequestWithOAuth } from './oauth-request.js';
export type { OAuthTokenProvider, OAuthTokenRequest, PreparedRequest } from './oauth-request.js';
export {
  oauthVaultKey,
  createOAuthVaultTokenProvider,
  OAuthSessionError,
} from '../../runtime-node/src/oauth/session-resolver.js';
export { connectOAuthSession } from '../../runtime-node/src/oauth/connect.js';
export type { ConnectOAuthOptions } from '../../runtime-node/src/oauth/connect.js';
