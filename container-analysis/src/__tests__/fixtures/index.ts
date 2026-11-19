import { GitImageUpdateKind, type GitDockerfile } from '@averlon/shared';

const baseLayer = {
  ID: 'layer-0',
  Command: 'FROM scratch',
  IsBaseImage: false,
};

const basePkg = {
  CurrentVersion: '1.0.0',
  FixedVersion: '1.0.1',
  Category: 'os',
  Type: 'deb',
  Deprecated: false,
  Abandoned: false,
  DependencyOf: [],
  CVEs: [],
  PackageID: 'pkg-000',
};

export const emptyDockerfile: GitDockerfile = {
  Path: 'Dockerfile',
  Layers: [],
};

export const singleLayerDockerfile: GitDockerfile = {
  Path: 'Dockerfile',
  Layers: [
    {
      ...baseLayer,
      Packages: [
        {
          ...basePkg,
          Name: 'libssl',
          PackageID: 'pkg-001',
          CodeDefects: [
            { ID: 'cd-001', PublicID: 'CVE-2023-0001' },
            { ID: 'cd-002', PublicID: 'CVE-2023-0002' },
          ],
        },
      ],
    },
  ],
};

export const multiLayerDockerfile: GitDockerfile = {
  Path: 'services/api/Dockerfile',
  Layers: [
    {
      ...baseLayer,
      Packages: [
        {
          ...basePkg,
          Name: 'openssl',
          PackageID: 'pkg-101',
          CodeDefects: [{ ID: 'cd-101', PublicID: 'CVE-2024-0101' }],
        },
        {
          ...basePkg,
          Name: 'curl',
          PackageID: 'pkg-102',
          CodeDefects: [{ ID: 'cd-102', PublicID: 'CVE-2024-0102' }],
        },
      ],
    },
    {
      ...baseLayer,
      Packages: [
        {
          ...basePkg,
          Name: 'zlib',
          PackageID: 'pkg-201',
          CodeDefects: [
            { ID: 'cd-201', PublicID: 'CVE-2024-0201' },
            { ID: 'cd-202', PublicID: 'CVE-2024-0202' },
          ],
        },
      ],
    },
  ],
};

/**
 * Dockerfile fixture where CodeDefects contain extra fields beyond { ID, PublicID }
 * to verify that buildDockerfilePrompt strips them out.
 */
// Simulates runtime API response where CodeDefects carry extra fields beyond CodeDefectRef.
export const dockerfileWithFullCodeDefects = {
  Path: 'Dockerfile',
  Layers: [
    {
      ...baseLayer,
      Packages: [
        {
          ...basePkg,
          Name: 'libssl',
          PackageID: 'pkg-full',
          CodeDefects: [
            {
              ID: 'cd-full-001',
              PublicID: 'CVE-2024-9999',
              OrgID: 'org-secret-123',
              LayerCommand: 'RUN apt-get install libssl',
              PackageName: 'libssl',
              Status: 1,
              Hash: 'abc123hash',
              CreatedAt: '2024-01-01T00:00:00Z',
              UpdatedAt: '2024-06-01T00:00:00Z',
            },
          ],
        },
      ],
    },
  ],
} as unknown as GitDockerfile;

export const noCodeDefectsDockerfile: GitDockerfile = {
  Path: 'Dockerfile',
  Layers: [
    {
      ...baseLayer,
      Packages: [{ ...basePkg, Name: 'bash', PackageID: 'pkg-bash', CodeDefects: [] }],
    },
  ],
};

/**
 * A private base image Dockerfile: no packages, only the base image update
 * found from the scan diff of its public parent.
 */
export const baseImageUpdateOnlyDockerfile: GitDockerfile = {
  Path: 'base_images/python-base/Dockerfile',
  Layers: [],
  BaseImageUpdate: {
    CurrentImage: 'docker.io/library/python:3.11-slim',
    Kind: GitImageUpdateKind.ChangeFrom,
    NewTag: '3.11.18-slim',
    NewDigest: 'sha256:new',
    FixedCVEs: ['CVE-2026-0001'],
    Reasoning: '3.11.18-slim is the latest image of the 3.11 slim line.',
  },
};

/**
 * A base image that is up to date, as the API sends it: the UpToDate kind,
 * with no new tag, no new digest and no CVE.
 */
export const upToDateBaseImageDockerfile: GitDockerfile = {
  Path: 'base_image_updates/orders/Dockerfile',
  Layers: [],
  BaseImageUpdate: {
    CurrentImage: '945236499471.dkr.ecr.us-west-2.amazonaws.com/platform/python-base:1.1.0',
    Kind: GitImageUpdateKind.UpToDate,
    Reasoning: '1.1.0 is the latest version.',
  },
};
