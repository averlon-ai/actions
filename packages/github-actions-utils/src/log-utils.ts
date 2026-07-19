/**
 * Re-export standard action logging from @averlon/shared.
 * Prefer importing configureActionLogging / logVerbose / logInfo from this package in actions.
 */
export {
  configureActionLogging,
  setVerboseLogging,
  isVerboseLoggingEnabled,
  logDebug,
  logVerbose,
  logInfo,
  logWarn,
  logError,
  logDetail,
  type ActionLogConfig,
} from '@averlon/shared';
