import { describe, expect, it } from 'bun:test';
import {
  buildGcpTerraformTypeCandidates,
  computeURLToResourceID,
  deriveGcpFullResourceName,
  expandGcpCandidates,
  gcpAPIURLToResourceID,
  normalizeGcpURLToResourceID,
  pulumiTypeToTerraformGoogleType,
  storageBucketCAI,
  storageURLToResourceID,
} from '../../src/gcp-resource-id';
import { extractTerraformCandidateIds } from '../../src/iac-resource';

describe('gcpAPIURLToResourceID', () => {
  it('converts modern service-host REST URLs', () => {
    const { id, ok } = gcpAPIURLToResourceID(
      'https://container.googleapis.com/v1beta1/projects/p/zones/z/clusters/c'
    );
    expect(ok).toBe(true);
    expect(id).toBe('//container.googleapis.com/projects/p/zones/z/clusters/c');
  });

  it('converts compute.googleapis.com URLs', () => {
    const { id, ok } = gcpAPIURLToResourceID(
      'https://compute.googleapis.com/v1/projects/p/zones/us-west1-a/instances/i'
    );
    expect(ok).toBe(true);
    expect(id).toBe('//compute.googleapis.com/projects/p/zones/us-west1-a/instances/i');
  });

  it('leaves legacy www host URLs unchanged', () => {
    const { id, ok } = gcpAPIURLToResourceID(
      'https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/i'
    );
    expect(ok).toBe(false);
    expect(id).toBe('https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/i');
  });
});

describe('computeURLToResourceID', () => {
  it('converts legacy compute API URLs', () => {
    const { id, ok } = computeURLToResourceID(
      'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/vm-1'
    );
    expect(ok).toBe(true);
    expect(id).toBe('//compute.googleapis.com/projects/p/zones/us-central1-a/instances/vm-1');
  });
});

describe('storage URL normalization', () => {
  it('converts www storage self_links to bucket CAI', () => {
    expect(
      storageURLToResourceID('https://www.googleapis.com/storage/v1/b/terraform-223406865036')
    ).toBe('//storage.googleapis.com/terraform-223406865036');
  });

  it('converts storage.googleapis.com self_links to bucket CAI', () => {
    expect(storageURLToResourceID('https://storage.googleapis.com/storage/v1/b/my-bucket')).toBe(
      '//storage.googleapis.com/my-bucket'
    );
  });

  it('normalizes bucket field prefixes', () => {
    expect(storageBucketCAI('b/terraform-223406865036')).toBe(
      '//storage.googleapis.com/terraform-223406865036'
    );
  });
});

describe('normalizeGcpURLToResourceID', () => {
  it('handles compute, modern, and storage URLs', () => {
    expect(
      normalizeGcpURLToResourceID(
        'https://www.googleapis.com/compute/v1/projects/p/global/networks/default'
      )
    ).toBe('//compute.googleapis.com/projects/p/global/networks/default');
    expect(
      normalizeGcpURLToResourceID(
        'https://container.googleapis.com/v1/projects/p/locations/us-central1/services/svc'
      )
    ).toBe('//container.googleapis.com/projects/p/locations/us-central1/services/svc');
    expect(
      normalizeGcpURLToResourceID('https://storage.googleapis.com/storage/v1/b/my-bucket')
    ).toBe('//storage.googleapis.com/my-bucket');
  });

  it('returns undefined for non-URLs', () => {
    expect(deriveGcpFullResourceName('not-a-url')).toBeUndefined();
  });
});

describe('buildGcpTerraformTypeCandidates', () => {
  it('builds storage bucket CAI from terraform state fields', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_storage_bucket', {
      id: 'terraform-223406865036',
      name: 'terraform-223406865036',
      self_link: 'https://www.googleapis.com/storage/v1/b/terraform-223406865036',
      url: 'gs://terraform-223406865036',
    });
    expect(candidates).toContain('//storage.googleapis.com/terraform-223406865036');
  });

  it('maps bucket IAM members to the parent bucket', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_storage_bucket_iam_member', {
      bucket: 'b/terraform-223406865036',
    });
    expect(candidates).toContain('//storage.googleapis.com/terraform-223406865036');
  });

  it('maps service accounts to iam CAI with unique_id (backend stores numeric id)', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_service_account', {
      email: 'sa@project.iam.gserviceaccount.com',
      project: 'my-project',
      unique_id: '101922844799162097499',
      id: 'projects/my-project/serviceAccounts/sa@project.iam.gserviceaccount.com',
    });
    expect(candidates).toContain(
      '//iam.googleapis.com/projects/my-project/serviceAccounts/101922844799162097499'
    );
    expect(candidates).toContain(
      '//iam.googleapis.com/projects/my-project/serviceAccounts/sa@project.iam.gserviceaccount.com'
    );
  });

  it('maps projects to both slug and number CRM CAI', () => {
    const projectNumbers = new Map([['goat-shared-1', '987604224719']]);
    const candidates = buildGcpTerraformTypeCandidates(
      'google_project',
      { project_id: 'goat-shared-1', number: '987604224719' },
      projectNumbers
    );
    expect(candidates).toContain('//cloudresourcemanager.googleapis.com/projects/goat-shared-1');
    expect(candidates).toContain('//cloudresourcemanager.googleapis.com/projects/987604224719');
  });

  it('maps project IAM members to numeric CRM CAI via project number map', () => {
    const projectNumbers = new Map([['goat-shared-1', '987604224719']]);
    const candidates = buildGcpTerraformTypeCandidates(
      'google_project_iam_member',
      { project: 'goat-shared-1', role: 'roles/viewer', member: 'user:foo@bar.com' },
      projectNumbers
    );
    expect(candidates).toContain('//cloudresourcemanager.googleapis.com/projects/987604224719');
  });

  it('maps organizations and projects to cloudresourcemanager CAI', () => {
    expect(
      buildGcpTerraformTypeCandidates('google_organization', {
        org_id: '223406865036',
        name: 'organizations/223406865036',
      })
    ).toContain('//cloudresourcemanager.googleapis.com/organizations/223406865036');

    expect(
      buildGcpTerraformTypeCandidates('google_project', { project_id: 'goat-standalone' })
    ).toContain('//cloudresourcemanager.googleapis.com/projects/goat-standalone');
  });

  it('maps artifact registry repositories', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_artifact_registry_repository', {
      project: 'goat-shared-1',
      location: 'us-west1',
      repository_id: 'secdi-artifact-registry',
      id: 'projects/goat-shared-1/locations/us-west1/repositories/secdi-artifact-registry',
    });
    expect(candidates).toContain(
      '//artifactregistry.googleapis.com/projects/goat-shared-1/locations/us-west1/repositories/secdi-artifact-registry'
    );
  });

  it('maps org policies', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_org_policy_policy', {
      name: 'organizations/223406865036/policies/gcp.resourceLocations',
    });
    expect(candidates).toContain(
      '//orgpolicy.googleapis.com/organizations/223406865036/policies/gcp.resourceLocations'
    );
  });

  it('maps tag bindings with full CRM CAI prefix', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_tags_tag_binding', {
      name: 'tagBindings/%2F%2Fcloudresourcemanager.googleapis.com%2Fprojects%2F987604224719/tagValues/281481858828393',
      parent: '//cloudresourcemanager.googleapis.com/projects/987604224719',
    });
    expect(candidates).toContain(
      '//cloudresourcemanager.googleapis.com/tagBindings/%2F%2Fcloudresourcemanager.googleapis.com%2Fprojects%2F987604224719/tagValues/281481858828393'
    );
  });

  it('maps secret manager with project number when available', () => {
    const projectNumbers = new Map([['goat-shared-1', '8150675178']]);
    const candidates = buildGcpTerraformTypeCandidates(
      'google_secret_manager_secret',
      { id: 'projects/goat-shared-1/secrets/my-secret' },
      projectNumbers
    );
    expect(candidates).toContain(
      '//secretmanager.googleapis.com/projects/8150675178/secrets/my-secret'
    );
  });

  it('maps billing account IAM to billing CAI', () => {
    const candidates = buildGcpTerraformTypeCandidates('google_billing_account_iam_member', {
      billing_account_id: '012345-678901-ABCDEF',
      role: 'roles/billing.viewer',
      member: 'serviceAccount:sa@project.iam.gserviceaccount.com',
    });
    expect(candidates).toContain(
      '//cloudbilling.googleapis.com/billingAccounts/012345-678901-ABCDEF'
    );
  });
});

describe('pulumiTypeToTerraformGoogleType', () => {
  it('maps camelCase Pulumi GCP types to Terraform google_* types', () => {
    expect(pulumiTypeToTerraformGoogleType('gcp:storage/bucket:Bucket')).toBe(
      'google_storage_bucket'
    );
    expect(pulumiTypeToTerraformGoogleType('gcp:projects/iAMMember:IAMMember')).toBe(
      'google_project_iam_member'
    );
    expect(pulumiTypeToTerraformGoogleType('gcp:serviceaccount/account:Account')).toBe(
      'google_service_account'
    );
    expect(pulumiTypeToTerraformGoogleType('gcp:artifactregistry/repository:Repository')).toBe(
      'google_artifact_registry_repository'
    );
  });
});

describe('extractTerraformCandidateIds GCP integration', () => {
  it('derives compute CAI from self_link', () => {
    const candidates = extractTerraformCandidateIds('google_compute_instance', {
      after: {
        id: 'projects/p/zones/us-central1-a/instances/vm-1',
        self_link:
          'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/vm-1',
      },
    });
    expect(candidates).toContain(
      '//compute.googleapis.com/projects/p/zones/us-central1-a/instances/vm-1'
    );
  });

  it('derives storage bucket CAI from self_link and bare name', () => {
    const candidates = extractTerraformCandidateIds('google_storage_bucket', {
      after: {
        id: 'my-bucket',
        name: 'my-bucket',
        self_link: 'https://www.googleapis.com/storage/v1/b/my-bucket',
      },
    });
    expect(candidates).toContain('//storage.googleapis.com/my-bucket');
  });

  it('expands gs:// URLs and bucket field prefixes', () => {
    const candidates = expandGcpCandidates(['gs://my-bucket', 'b/my-bucket']);
    expect(candidates).toEqual([
      '//storage.googleapis.com/my-bucket',
      '//storage.googleapis.com/my-bucket',
    ]);
  });
});
