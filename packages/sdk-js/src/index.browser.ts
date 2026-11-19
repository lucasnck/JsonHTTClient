/**
 * Browser-safe subset (T08 bootstrap): no Node filesystem, no Node fetch adapter,
 * no OAuth keychain/callback. A full browser transport and CDN bundling remain PENDING.
 */
export type * from '../../core/src/contracts/types.js';
export {validateRequestFile,validateExecutionResult,validateExecutionBatchResult,normalizeRequestHeaders} from '../../core/src/contracts/validation.js';
export {createVariableSnapshot,compareVariableFileNames,isVariablesFileName,validateVariablesFile,planVariableFileActivation} from '../../core/src/variables/variables.js';
export {interpolateRequest,TemplateResolver,TemplateError,PLACEHOLDER} from '../../core/src/templates/interpolation.js';
export type {TemplateOptions,TemplateResolution,TemplateErrorCode} from '../../core/src/templates/interpolation.js';
export {findPlaceholders,hoverVariable,completeAt,diagnosePlaceholders} from '../../language-service/src/language-service.js';
export {checkHttpTarget,HttpPolicyError,approveProtectedExecution,isPrivateHostname} from '../../core/src/security/policies.js';
export type {HttpNetworkPolicy,ApprovalAdapter,ApprovalRequest} from '../../core/src/security/policies.js';
