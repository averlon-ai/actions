/** Constants of the GitHub action only; the scan's are in @averlon-ai/cynos-scan-engine. */

/** Run titles name the kind of scan; the daily diff finds its starting point by them. */
export const TITLE_PREFIX = 'cynos-scan: ';
/** diff-base value meaning "the commit of the last successful full or diff scan". */
export const LAST_SCAN = 'last-scan';
/** The artifact a starting-point run uploads once it has covered its commit. */
export const COVERED_ARTIFACT = 'cynos-scan-covered';
