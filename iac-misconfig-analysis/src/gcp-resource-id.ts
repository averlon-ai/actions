/**
 * GCP Cloud Asset Inventory (CAI) resource ID normalization.
 *
 * Averlon stores GCP asset ResourceIDs as CAI full resource names
 * (`//service.googleapis.com/...`). This module mirrors the conversions in
 * secdi/internal/gcpprov/resourceid.go and terraform-type-specific builders
 * used when correlating IaC resources with existing issues.
 */

const GCP_API_VERSION_RE = /^v[0-9][a-z0-9]*$/;
const COMPUTE_API_URL_PREFIX = 'https://www.googleapis.com/compute/v1/';
const STORAGE_BUCKET_URL_RE =
  /^https:\/\/(?:www\.googleapis\.com\/storage|storage\.googleapis\.com\/storage)\/v1\/b\/([^/?#]+)/;
const STORAGE_BUCKET_FIELD_RE = /^b\/([^/]+)$/;
const NUMERIC_ID_RE = /^\d+$/;
const SERVICE_ACCOUNT_PATH_RE = /^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/;
const CAI_GOOGLEAPIS_RESOURCE_RE = /^\/\/(?:[a-z0-9-]+\.)*googleapis\.com\/.+$/i;

/** Maps Terraform project_id slug → project number (from google_project resources in the same plan). */
export type ProjectNumberMap = Map<string, string>;

export interface GcpCandidateContext {
  projectNumbers?: ProjectNumberMap;
}

export function gcpAPIURLToResourceID(rawURL: string): { id: string; ok: boolean } {
  const prefix = 'https://';
  if (!rawURL.startsWith(prefix)) {
    return { id: rawURL, ok: false };
  }
  const rest = rawURL.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return { id: rawURL, ok: false };
  }
  const host = rest.slice(0, slash);
  if (!host.endsWith('.googleapis.com') || host === 'www.googleapis.com') {
    return { id: rawURL, ok: false };
  }
  let path = rest.slice(slash + 1);
  const nextSlash = path.indexOf('/');
  if (nextSlash > 0 && GCP_API_VERSION_RE.test(path.slice(0, nextSlash))) {
    path = path.slice(nextSlash + 1);
  }
  if (!path) {
    return { id: rawURL, ok: false };
  }
  return { id: `//${host}/${path}`, ok: true };
}

export function computeURLToResourceID(rawURL: string): { id: string; ok: boolean } {
  if (!rawURL.startsWith(COMPUTE_API_URL_PREFIX)) {
    return { id: rawURL, ok: false };
  }
  return {
    id: `//compute.googleapis.com/${rawURL.slice(COMPUTE_API_URL_PREFIX.length)}`,
    ok: true,
  };
}

/** Legacy www host form: https://www.googleapis.com/<service>/<version>/<path> */
export function wwwAPIURLToResourceID(rawURL: string): { id: string; ok: boolean } {
  const match = /^https:\/\/www\.googleapis\.com\/([^/]+)\/([^/]+)\/(.+)$/.exec(rawURL.trim());
  if (!match) {
    return { id: rawURL, ok: false };
  }
  const [, service, version, path] = match;
  if (!service || !version || !path || !GCP_API_VERSION_RE.test(version)) {
    return { id: rawURL, ok: false };
  }
  return { id: `//${service}.googleapis.com/${path}`, ok: true };
}

export function storageURLToResourceID(rawURL: string): string | undefined {
  const match = STORAGE_BUCKET_URL_RE.exec(rawURL.trim());
  return match?.[1] ? `//storage.googleapis.com/${match[1]}` : undefined;
}

export function storageBucketCAI(bucket: string): string {
  const trimmed = bucket.trim();
  const fieldMatch = STORAGE_BUCKET_FIELD_RE.exec(trimmed);
  const name = fieldMatch?.[1] ?? trimmed;
  return `//storage.googleapis.com/${name}`;
}

export function gcpCAI(service: string, relativePath: string): string {
  const path = relativePath.replace(/^\/+/, '');
  return `//${service}/${path}`;
}

export function normalizeGcpURLToResourceID(rawURL: string): string | undefined {
  const storage = storageURLToResourceID(rawURL);
  if (storage) return storage;

  const modern = gcpAPIURLToResourceID(rawURL);
  if (modern.ok) {
    if (modern.id.startsWith('//storage.googleapis.com/b/')) {
      const bucket = modern.id.slice('//storage.googleapis.com/b/'.length);
      return bucket ? `//storage.googleapis.com/${bucket}` : undefined;
    }
    return modern.id;
  }

  const compute = computeURLToResourceID(rawURL);
  if (compute.ok) return compute.id;

  const www = wwwAPIURLToResourceID(rawURL);
  if (www.ok) return www.id;

  return undefined;
}

function gcpServiceForTerraformType(type: string): string | undefined {
  if (type.startsWith('google_compute_')) return 'compute.googleapis.com';
  if (type.startsWith('google_artifact_registry_')) return 'artifactregistry.googleapis.com';
  if (type.startsWith('google_service_account')) return 'iam.googleapis.com';
  if (type.startsWith('google_project_iam_custom_role')) return 'iam.googleapis.com';
  if (type.startsWith('google_organization_iam_custom_role')) return 'iam.googleapis.com';
  if (type.startsWith('google_storage_')) return 'storage.googleapis.com';
  if (type.startsWith('google_kms_')) return 'cloudkms.googleapis.com';
  if (type.startsWith('google_secret_manager_')) return 'secretmanager.googleapis.com';
  if (type.startsWith('google_container_')) return 'container.googleapis.com';
  if (type.startsWith('google_cloud_run_')) return 'run.googleapis.com';
  if (type.startsWith('google_cloudfunctions')) return 'cloudfunctions.googleapis.com';
  if (type.startsWith('google_org_policy_')) return 'orgpolicy.googleapis.com';
  if (type.startsWith('google_tags_')) return 'cloudresourcemanager.googleapis.com';
  if (type.startsWith('google_iam_workload_identity')) return 'iam.googleapis.com';
  if (type.startsWith('google_billing_account')) return 'cloudbilling.googleapis.com';
  if (type.startsWith('google_privileged_access_manager_')) {
    return 'privilegedaccessmanager.googleapis.com';
  }
  if (type.startsWith('google_project_service')) return 'serviceusage.googleapis.com';
  if (type.startsWith('google_redis_')) return 'redis.googleapis.com';
  if (type.startsWith('google_filestore_')) return 'file.googleapis.com';
  if (type.startsWith('google_pubsub_')) return 'pubsub.googleapis.com';
  if (type.startsWith('google_logging_')) return 'logging.googleapis.com';
  if (type.startsWith('google_monitoring_')) return 'monitoring.googleapis.com';
  if (type.startsWith('google_scc_')) return 'securitycenter.googleapis.com';
  if (type.startsWith('google_os_config_')) return 'osconfig.googleapis.com';
  if (type.startsWith('google_cloud_ids_')) return 'ids.googleapis.com';
  if (type.startsWith('google_service_networking_')) return 'servicenetworking.googleapis.com';
  if (
    type === 'google_project' ||
    type === 'google_folder' ||
    type === 'google_organization' ||
    type.startsWith('google_project_') ||
    type.startsWith('google_organization_') ||
    type.startsWith('google_folder_')
  ) {
    return 'cloudresourcemanager.googleapis.com';
  }
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asTrimmedNumberString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asTrimmedString(value);
}

function addCandidate(candidates: string[], value: string | undefined): void {
  if (value) candidates.push(value);
}

function addRelativePathCandidate(
  candidates: string[],
  service: string | undefined,
  value: string | undefined
): void {
  if (!service || !value) return;
  const trimmed = value.trim();
  if (
    trimmed.startsWith('projects/') ||
    trimmed.startsWith('organizations/') ||
    trimmed.startsWith('folders/') ||
    trimmed.startsWith('billingAccounts/') ||
    trimmed.startsWith('tagKeys/') ||
    trimmed.startsWith('tagValues/') ||
    trimmed.startsWith('tagBindings/')
  ) {
    candidates.push(gcpCAI(service, trimmed));
  }
}

/** Emit both project_id slug and project number CRM CAIs when the map provides a number. */
function addProjectCAIs(
  candidates: string[],
  projectRef: string | undefined,
  projectNumbers?: ProjectNumberMap
): void {
  if (!projectRef) return;
  addCandidate(candidates, gcpCAI('cloudresourcemanager.googleapis.com', `projects/${projectRef}`));
  const number = projectNumbers?.get(projectRef);
  if (number && number !== projectRef) {
    addCandidate(candidates, gcpCAI('cloudresourcemanager.googleapis.com', `projects/${number}`));
  }
}

/** Resolve a project reference to the numeric form preferred by discovery for some services. */
function resolveProjectNumber(
  projectRef: string | undefined,
  projectNumbers?: ProjectNumberMap
): string | undefined {
  if (!projectRef) return undefined;
  if (NUMERIC_ID_RE.test(projectRef)) return projectRef;
  return projectNumbers?.get(projectRef) ?? projectRef;
}

function addProjectScopedCAI(
  candidates: string[],
  service: string,
  projectRef: string | undefined,
  suffix: string,
  projectNumbers?: ProjectNumberMap
): void {
  const slugPath = projectRef ? `projects/${projectRef}/${suffix}` : undefined;
  if (slugPath) addCandidate(candidates, gcpCAI(service, slugPath));

  const number = resolveProjectNumber(projectRef, projectNumbers);
  if (number && number !== projectRef) {
    addCandidate(candidates, gcpCAI(service, `projects/${number}/${suffix}`));
  }
}

function parseServiceAccountPath(path: string): { project?: string; accountId?: string } {
  const match = SERVICE_ACCOUNT_PATH_RE.exec(path.trim());
  if (!match) return {};
  return { project: match[1], accountId: match[2] };
}

function buildServiceAccountCandidates(
  record: Record<string, unknown>,
  projectNumbers?: ProjectNumberMap
): string[] {
  const candidates: string[] = [];
  const email = asTrimmedString(record['email']);
  const name = asTrimmedString(record['name']);
  const id = asTrimmedString(record['id']);
  const project = asTrimmedString(record['project']);
  const uniqueId = asTrimmedString(record['unique_id']);

  for (const path of [id, name]) {
    if (!path?.startsWith('projects/')) continue;
    addCandidate(candidates, gcpCAI('iam.googleapis.com', path));
    const parsed = parseServiceAccountPath(path);
    if (parsed.project && parsed.accountId && NUMERIC_ID_RE.test(parsed.accountId)) {
      addCandidate(
        candidates,
        gcpCAI(
          'iam.googleapis.com',
          `projects/${parsed.project}/serviceAccounts/${parsed.accountId}`
        )
      );
      const number = resolveProjectNumber(parsed.project, projectNumbers);
      if (number && number !== parsed.project) {
        addCandidate(
          candidates,
          gcpCAI('iam.googleapis.com', `projects/${number}/serviceAccounts/${parsed.accountId}`)
        );
      }
    }
  }

  if (uniqueId && project) {
    addCandidate(
      candidates,
      gcpCAI('iam.googleapis.com', `projects/${project}/serviceAccounts/${uniqueId}`)
    );
    const number = resolveProjectNumber(project, projectNumbers);
    if (number && number !== project) {
      addCandidate(
        candidates,
        gcpCAI('iam.googleapis.com', `projects/${number}/serviceAccounts/${uniqueId}`)
      );
    }
  }

  if (email && project) {
    addCandidate(
      candidates,
      gcpCAI('iam.googleapis.com', `projects/${project}/serviceAccounts/${email}`)
    );
  }

  return candidates;
}

function buildStorageBucketCandidates(record: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const bucket = asTrimmedString(record['bucket']);
  const selfLink = asTrimmedString(record['self_link']);
  const url = asTrimmedString(record['url']);
  const rawId = asTrimmedString(record['id']);
  const name =
    asTrimmedString(record['name']) ?? (rawId && !rawId.includes('/roles/') ? rawId : undefined);

  if (name) addCandidate(candidates, storageBucketCAI(name));
  if (bucket) addCandidate(candidates, storageBucketCAI(bucket));
  if (selfLink) addCandidate(candidates, normalizeGcpURLToResourceID(selfLink));
  if (url?.startsWith('gs://'))
    addCandidate(candidates, storageBucketCAI(url.slice('gs://'.length)));

  return candidates;
}

function buildIamParentCandidates(
  type: string,
  record: Record<string, unknown>,
  projectNumbers?: ProjectNumberMap
): string[] {
  const candidates: string[] = [];
  const project = asTrimmedString(record['project']);
  const orgId = asTrimmedString(record['org_id']);
  const region = asTrimmedString(record['region']);
  const location = asTrimmedString(record['location']) ?? region;
  const service = asTrimmedString(record['service']);

  if (type.includes('storage_bucket')) {
    candidates.push(...buildStorageBucketCandidates(record));
    return candidates;
  }

  if (type.includes('service_account')) {
    const serviceAccountId = asTrimmedString(record['service_account_id']);
    if (serviceAccountId) {
      candidates.push(
        ...buildServiceAccountCandidates(
          { ...record, id: serviceAccountId, name: serviceAccountId },
          projectNumbers
        )
      );
    }
    return candidates;
  }

  if (type.includes('artifact_registry_repository')) {
    const repository =
      asTrimmedString(record['repository']) ?? asTrimmedString(record['repository_id']);
    if (project && location && repository) {
      addCandidate(
        candidates,
        gcpCAI(
          'artifactregistry.googleapis.com',
          `projects/${project}/locations/${location}/repositories/${repository}`
        )
      );
    }
    addRelativePathCandidate(
      candidates,
      'artifactregistry.googleapis.com',
      asTrimmedString(record['id'])
    );
    return candidates;
  }

  if (type.includes('kms_key_ring') || type.includes('kms_crypto_key')) {
    const keyRingId = asTrimmedString(record['key_ring_id']);
    addRelativePathCandidate(candidates, 'cloudkms.googleapis.com', keyRingId);
    const cryptoKeyId = asTrimmedString(record['crypto_key_id']);
    addRelativePathCandidate(candidates, 'cloudkms.googleapis.com', cryptoKeyId);
    return candidates;
  }

  if (type.includes('secret_manager_secret')) {
    const secretId = asTrimmedString(record['secret_id']);
    if (secretId) {
      addCandidate(candidates, gcpCAI('secretmanager.googleapis.com', secretId));
      const match = /^projects\/([^/]+)\/secrets\/(.+)$/.exec(secretId);
      if (match) {
        addProjectScopedCAI(
          candidates,
          'secretmanager.googleapis.com',
          match[1],
          `secrets/${match[2]}`,
          projectNumbers
        );
      }
    }
    return candidates;
  }

  if (type.includes('cloud_run')) {
    if (project && location && service) {
      addCandidate(
        candidates,
        gcpCAI(
          'run.googleapis.com',
          `projects/${project}/locations/${location}/services/${service}`
        )
      );
    }
    return candidates;
  }

  if (type.includes('billing_account')) {
    const billingAccountId = asTrimmedString(record['billing_account_id']);
    if (billingAccountId) {
      const path = billingAccountId.startsWith('billingAccounts/')
        ? billingAccountId
        : `billingAccounts/${billingAccountId}`;
      addCandidate(candidates, gcpCAI('cloudbilling.googleapis.com', path));
    }
    return candidates;
  }

  if (type.includes('project_iam') && project) {
    addProjectCAIs(candidates, project, projectNumbers);
    return candidates;
  }

  if (type.includes('organization_iam') && orgId) {
    addCandidate(
      candidates,
      gcpCAI('cloudresourcemanager.googleapis.com', `organizations/${orgId}`)
    );
    addRelativePathCandidate(
      candidates,
      'cloudresourcemanager.googleapis.com',
      asTrimmedString(record['name'])
    );
    return candidates;
  }

  return candidates;
}

export function buildGcpTerraformTypeCandidates(
  type: string,
  record?: Record<string, unknown>,
  projectNumbers?: ProjectNumberMap
): string[] {
  if (!record) return [];
  const candidates: string[] = [];
  const service = gcpServiceForTerraformType(type);

  switch (type) {
    case 'google_storage_bucket':
      candidates.push(...buildStorageBucketCandidates(record));
      break;

    case 'google_service_account':
      candidates.push(...buildServiceAccountCandidates(record, projectNumbers));
      break;

    case 'google_project': {
      const projectId = asTrimmedString(record['project_id']) ?? asTrimmedString(record['id']);
      const number = asTrimmedNumberString(record['number']);
      addProjectCAIs(candidates, projectId, projectNumbers);
      if (number) {
        addCandidate(
          candidates,
          gcpCAI('cloudresourcemanager.googleapis.com', `projects/${number}`)
        );
      }
      break;
    }

    case 'google_organization': {
      const orgId = asTrimmedString(record['org_id']);
      const name = asTrimmedString(record['name']) ?? asTrimmedString(record['id']);
      if (orgId) {
        addCandidate(
          candidates,
          gcpCAI('cloudresourcemanager.googleapis.com', `organizations/${orgId}`)
        );
      }
      addRelativePathCandidate(candidates, 'cloudresourcemanager.googleapis.com', name);
      break;
    }

    case 'google_folder': {
      const folderId = asTrimmedString(record['folder_id']) ?? asTrimmedString(record['id']);
      if (folderId) {
        const path = folderId.startsWith('folders/') ? folderId : `folders/${folderId}`;
        addCandidate(candidates, gcpCAI('cloudresourcemanager.googleapis.com', path));
      }
      break;
    }

    case 'google_artifact_registry_repository': {
      const id = asTrimmedString(record['id']);
      addRelativePathCandidate(candidates, 'artifactregistry.googleapis.com', id);
      const project = asTrimmedString(record['project']);
      const location = asTrimmedString(record['location']);
      const repositoryId = asTrimmedString(record['repository_id']);
      if (project && location && repositoryId) {
        addCandidate(
          candidates,
          gcpCAI(
            'artifactregistry.googleapis.com',
            `projects/${project}/locations/${location}/repositories/${repositoryId}`
          )
        );
      }
      break;
    }

    case 'google_org_policy_policy': {
      const name = asTrimmedString(record['name']);
      if (name) addCandidate(candidates, gcpCAI('orgpolicy.googleapis.com', name));
      break;
    }

    case 'google_project_iam_custom_role':
    case 'google_organization_iam_custom_role': {
      const roleId = asTrimmedString(record['role_id']) ?? asTrimmedString(record['id']);
      addRelativePathCandidate(candidates, 'iam.googleapis.com', roleId);
      break;
    }

    case 'google_tags_tag_key':
    case 'google_tags_tag_value': {
      const id = asTrimmedString(record['id']);
      const name = asTrimmedString(record['name']);
      addRelativePathCandidate(candidates, 'cloudresourcemanager.googleapis.com', id);
      addRelativePathCandidate(candidates, 'cloudresourcemanager.googleapis.com', name);
      break;
    }

    case 'google_tags_tag_binding': {
      const name = asTrimmedString(record['name']);
      const parent = asTrimmedString(record['parent']);
      if (name?.startsWith('tagBindings/')) {
        addCandidate(candidates, gcpCAI('cloudresourcemanager.googleapis.com', name));
      }
      if (parent?.startsWith('//cloudresourcemanager.googleapis.com/')) {
        addCandidate(candidates, parent);
      }
      break;
    }

    case 'google_project_service': {
      const project = asTrimmedString(record['project']);
      const serviceApi = asTrimmedString(record['service']);
      const projectRef = resolveProjectNumber(project, projectNumbers);
      if (projectRef && serviceApi) {
        addCandidate(
          candidates,
          gcpCAI('serviceusage.googleapis.com', `projects/${projectRef}/services/${serviceApi}`)
        );
      }
      break;
    }

    case 'google_secret_manager_secret': {
      const id = asTrimmedString(record['id']);
      if (id) {
        addCandidate(candidates, gcpCAI('secretmanager.googleapis.com', id));
        const match = /^projects\/([^/]+)\/secrets\/(.+)$/.exec(id);
        if (match) {
          addProjectScopedCAI(
            candidates,
            'secretmanager.googleapis.com',
            match[1],
            `secrets/${match[2]}`,
            projectNumbers
          );
        }
      }
      break;
    }

    case 'google_iam_workload_identity_pool':
    case 'google_iam_workload_identity_pool_provider': {
      const name = asTrimmedString(record['name']) ?? asTrimmedString(record['id']);
      addRelativePathCandidate(candidates, 'iam.googleapis.com', name);
      break;
    }

    default:
      if (type.endsWith('_iam_member') || type.endsWith('_iam_binding')) {
        candidates.push(...buildIamParentCandidates(type, record, projectNumbers));
      }
      break;
  }

  for (const key of ['self_link', 'name']) {
    addRelativePathCandidate(candidates, service, asTrimmedString(record[key]));
  }
  if (!type.endsWith('_iam_member') && !type.endsWith('_iam_binding')) {
    addRelativePathCandidate(candidates, service, asTrimmedString(record['id']));
  }

  return candidates;
}

export function expandGcpCandidates(ids: string[]): string[] {
  const expanded: string[] = [];
  for (const id of ids) {
    if (CAI_GOOGLEAPIS_RESOURCE_RE.test(id)) {
      expanded.push(id);
      continue;
    }
    if (id.startsWith('https://')) {
      const normalized = normalizeGcpURLToResourceID(id);
      if (normalized) {
        expanded.push(normalized);
        continue;
      }
      expanded.push(id);
      continue;
    }
    if (id.startsWith('gs://')) {
      expanded.push(storageBucketCAI(id.slice('gs://'.length)));
      continue;
    }
    const bucketField = STORAGE_BUCKET_FIELD_RE.exec(id);
    if (bucketField?.[1]) {
      expanded.push(storageBucketCAI(bucketField[1]));
      continue;
    }
    expanded.push(id);
  }
  return expanded;
}

/** @deprecated Use normalizeGcpURLToResourceID; kept for existing tests/imports. */
export function deriveGcpFullResourceName(selfLink: string): string | undefined {
  return normalizeGcpURLToResourceID(selfLink);
}

export function isGcpTerraformType(type: string): boolean {
  return type.startsWith('google_');
}

export function isGcpPulumiType(type: string): boolean {
  return type.startsWith('gcp:');
}

/** Build project_id → number map from google_project resources in a Terraform plan. */
export function buildProjectNumberMap(
  resourceChanges: Array<{ type?: string; change?: Record<string, unknown> }>
): ProjectNumberMap {
  const map: ProjectNumberMap = new Map();
  for (const item of resourceChanges) {
    if (item.type !== 'google_project') continue;
    const change = item.change;
    if (!change) continue;
    for (const stateKey of ['after', 'before'] as const) {
      const state = change[stateKey];
      if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
      const record = state as Record<string, unknown>;
      const projectId = asTrimmedString(record['project_id']) ?? asTrimmedString(record['id']);
      const number = asTrimmedNumberString(record['number']);
      if (projectId && number) map.set(projectId, number);
    }
  }
  return map;
}

const PULUMI_GCP_MODULE_ALIASES: Record<string, string> = {
  projects: 'project',
  organizations: 'organization',
  serviceaccount: 'service_account',
  artifactregistry: 'artifact_registry',
  secretmanager: 'secret_manager',
  cloudrun: 'cloud_run',
  cloudrunv2: 'cloud_run',
};

function camelToSnake(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function singularizeGcpModule(module: string): string {
  return PULUMI_GCP_MODULE_ALIASES[module] ?? module;
}

function normalizePulumiResourceName(resource: string): string {
  return resource.replace(/^i_am_/, 'iam_');
}

/** Map Pulumi GCP type tokens to Terraform google_* resource type strings. */
export function pulumiTypeToTerraformGoogleType(pulumiType: string): string {
  if (!pulumiType.startsWith('gcp:')) return '';
  const withoutProvider = pulumiType.slice('gcp:'.length);
  const typeColon = withoutProvider.lastIndexOf(':');
  const typePath = typeColon >= 0 ? withoutProvider.slice(0, typeColon) : withoutProvider;
  const slash = typePath.indexOf('/');
  if (slash < 0) {
    return `google_${singularizeGcpModule(camelToSnake(typePath))}`;
  }
  const module = singularizeGcpModule(camelToSnake(typePath.slice(0, slash)));
  const resource = normalizePulumiResourceName(camelToSnake(typePath.slice(slash + 1)));
  if (module === 'service_account' && resource === 'account') {
    return 'google_service_account';
  }
  return `google_${module}_${resource}`;
}
