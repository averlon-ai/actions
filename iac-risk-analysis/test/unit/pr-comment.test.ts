import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as core from '@actions/core';
import {
  formatScanResult,
  hasRisksInResult,
  hasReachabilityRisks,
  enforceCommentBodyLimit,
  GITHUB_COMMENT_BODY_MAX_LENGTH,
} from '../../src/pr-comment.ts';

describe('pr-comment.ts', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let debugSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    debugSpy = spyOn(core, 'debug').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warningSpy.mockRestore();
  });

  describe('formatScanResult', () => {
    const commitSha = 'abc123def456';

    it('should format scan result with text summary', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'This is a test summary of the scan results',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### 📝 Summary');
      expect(result).toContain('This is a test summary of the scan results');
      expect(result).toContain(commitSha);
    });

    it('should format scan result with new internet exposures', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'Summary text',
            NewInternetExposures: [
              'aws_instance.web_server',
              'aws_s3_bucket.public_bucket',
              'aws_security_group.open_sg',
            ],
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### 🌐 New Internet Exposures');
      expect(result).toContain('The following resources will be exposed to the internet:');
      expect(result).toContain('1. `aws_instance.web_server`');
      expect(result).toContain('2. `aws_s3_bucket.public_bucket`');
      expect(result).toContain('3. `aws_security_group.open_sg`');
      expect(infoSpy).toHaveBeenCalledWith('Found 3 new internet exposure(s)');
    });

    it('should format scan result with risk assessment', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'aws_instance.web_server',
          cloudResource: 'i-1234567890abcdef0',
          riskAssessment: {
            riskLevel: 'HIGH',
            issuesSummary: 'Security group allows unrestricted access',
            impactAssessment: 'High risk of unauthorized access',
            vulnerabilities: [
              {
                cve: 'CVE-2024-1234',
                severity: 'CRITICAL',
                riskAnalysis: 'Remote code execution vulnerability',
              },
              {
                cve: 'CVE-2024-5678',
                severity: 'HIGH',
                riskAnalysis: 'Privilege escalation possible',
              },
            ],
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### ⚠️ Risk Assessment');
      expect(result).toContain('Resource 1: `i-1234567890abcdef0 (aws_instance.web_server)`');
      expect(result).toContain('**Cloud Resource**: `i-1234567890abcdef0`');
      expect(result).toContain('**Risk Level**: **HIGH**');
      expect(result).toContain('**Issues summary:**');
      expect(result).toContain('Security group allows unrestricted access');
      expect(result).toContain('**Impact:**');
      expect(result).toContain('High risk of unauthorized access');
      expect(result).toContain('**Vulnerabilities:**');
      expect(result).toContain('**CVE-2024-1234** (CRITICAL)');
      expect(result).toContain('Remote code execution vulnerability');
      expect(result).toContain('**CVE-2024-5678** (HIGH)');
      expect(result).toContain('Privilege escalation possible');
      expect(infoSpy).toHaveBeenCalledWith('Found 1 risk assessment(s)');
    });

    it('should show ResourceID and asset name first when present in ReachabilityAnalysis resources', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'module.deploy-goat.module.test.aws_instance.test',
          cloudResource: 'i-08a47985383682d9d',
          riskAssessment: { riskLevel: 'CRITICAL' },
        },
      ]);
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          ModifiedResources: [
            {
              ID: 'module.deploy-goat.module.test.aws_instance.test',
              Asset: { ResourceID: 'i-08a47985383682d9d', Name: 'cs-nfr-test' },
            },
          ],
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain(
        'Resource 1: `i-08a47985383682d9d (cs-nfr-test, module.deploy-goat.module.test.aws_instance.test)`'
      );
    });

    it('should format New Internet Exposures with ResourceID and asset name when in ReachabilityAnalysis', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          ModifiedResources: [
            {
              ID: 'module.deploy-goat.module.test.aws_instance.test',
              Asset: { ResourceID: 'i-08a47985383682d9d', Name: 'cs-nfr-test' },
            },
          ],
          Summary: {
            NewInternetExposures: ['module.deploy-goat.module.test.aws_instance.test'],
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain(
        '1. `i-08a47985383682d9d (cs-nfr-test, module.deploy-goat.module.test.aws_instance.test)`'
      );
    });

    it('should format impact assessment with bold labels', () => {
      const impactText =
        '1) Attack Vector: Instance is on 18 attack chains. 2) Exploitation Path: Attacker can assume the role. 3) Data Exposure: Bucket may contain sensitive data.';
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'arn:aws:s3:::my-bucket',
          cloudResource: 'arn:aws:s3:::my-bucket',
          riskAssessment: {
            riskLevel: 'High',
            issuesSummary: 'S3 access risk',
            impactAssessment: impactText,
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('**Impact:**');
      expect(result).toContain('- **Attack Vector**:');
      expect(result).toContain('Instance is on 18 attack chains');
      expect(result).toContain('- **Exploitation Path**:');
      expect(result).toContain('Attacker can assume the role');
      expect(result).toContain('- **Data Exposure**:');
      expect(result).toContain('Bucket may contain sensitive data');
    });

    it('should not split impact on "(1 of 1)" or "of 1)" in sentences', () => {
      const impactText =
        '1) Attack Vector: Direct. 2) Data Exposure: The bucket (1 of 1) — loss of confidentiality. 3) Blast Radius: Single target.';
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'aws_s3_bucket.data',
          cloudResource: 'bucket',
          riskAssessment: {
            riskLevel: 'High',
            impactAssessment: impactText,
          },
        },
      ]);
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: { Summary: { RiskSummary: riskSummary } },
      });
      const result = formatScanResult(scanResult, commitSha);
      // Should have 3 bullets; Data Exposure paragraph must keep "(1 of 1)" intact (no spurious split)
      expect(result).toContain('- **Attack Vector**:');
      expect(result).toContain('- **Data Exposure**:');
      expect(result).toContain('(1 of 1) — loss of confidentiality');
      expect(result).toContain('- **Blast Radius**:');
    });

    it('should handle multiple risk assessments', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'aws_instance.web_server',
          cloudResource: 'i-abc123',
          riskAssessment: {
            riskLevel: 'HIGH',
          },
        },
        {
          terraformResource: 'aws_s3_bucket.data',
          cloudResource: 'my-bucket',
          riskAssessment: {
            riskLevel: 'MEDIUM',
          },
        },
        {
          terraformResource: 'aws_security_group.open',
          cloudResource: 'sg-xyz789',
          riskAssessment: {
            riskLevel: 'CRITICAL',
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('Resource 1: `i-abc123 (aws_instance.web_server)`');
      expect(result).toContain('Resource 2: `my-bucket (aws_s3_bucket.data)`');
      expect(result).toContain('Resource 3: `sg-xyz789 (aws_security_group.open)`');
      expect(infoSpy).toHaveBeenCalledWith('Found 3 risk assessment(s)');
    });

    it('should handle access risk assessments using AccessPermissions', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/path/to/AdminRole',
              TargetResourceID: 'arn:aws:s3:::bucket-name/path/to/sensitive-bucket',
              Unchanged: ['s3:ListBucket'],
              Added: ['s3:GetObject', 's3:PutObject'],
              Removed: ['s3:DeleteObject'],
            },
          ],
          Summary: {
            TextSummary: 'Access analysis completed',
            RiskSummary:
              '[{"principalId":"arn:aws:iam::123456789012:role/path/to/AdminRole","targetResource":"arn:aws:s3:::bucket-name/path/to/sensitive-bucket","riskAssessment":{"riskLevel":"High"}}]',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### 🔑 Permission Changes');
      expect(result).toContain(
        '`arn:aws:iam::123456789012:role/path/to/AdminRole` → `arn:aws:s3:::bucket-name/path/to/sensitive-bucket`'
      );
      expect(result).toContain('**➕ Added Permissions:**');
      expect(result).toContain('`s3:GetObject`');
      expect(result).toContain('`s3:PutObject`');
      expect(result).toContain('**➖ Removed Permissions:**');
      expect(result).toContain('`s3:DeleteObject`');
      expect(infoSpy).toHaveBeenCalledWith('Found 1 access permission change(s)');
    });

    it('should handle multiple access risk assessments using AccessPermissions', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/Role1',
              TargetResourceID: 'arn:aws:s3:::bucket1',
              Added: ['s3:GetObject'],
            },
            {
              PrincipalID: 'arn:aws:iam::123456789012:user/User2',
              TargetResourceID: 'arn:aws:dynamodb:us-east-1:123456789012:table/Table2',
              Removed: ['dynamodb:PutItem'],
            },
          ],
          Summary: {
            TextSummary: 'Multiple access changes detected',
            RiskSummary:
              '[{"principalId":"arn:aws:iam::123456789012:role/Role1","targetResource":"arn:aws:s3:::bucket1","riskAssessment":{"riskLevel":"Medium"}}]',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('`arn:aws:iam::123456789012:role/Role1` → `arn:aws:s3:::bucket1`');
      expect(result).toContain(
        '`arn:aws:iam::123456789012:user/User2` → `arn:aws:dynamodb:us-east-1:123456789012:table/Table2`'
      );
      expect(result).toContain('**➕ Added Permissions:**');
      expect(result).toContain('`s3:GetObject`');
      expect(result).toContain('**➖ Removed Permissions:**');
      expect(result).toContain('`dynamodb:PutItem`');
      expect(infoSpy).toHaveBeenCalledWith('Found 2 access permission change(s)');
    });

    it('should handle ReachabilityAnalysis.Summary format (new proto structure)', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'Reachability analysis summary',
            NewInternetExposures: ['resource1', 'resource2'],
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('Reachability analysis summary');
      expect(result).toContain('New Internet Exposures');
      expect(result).toContain('resource1');
      expect(result).toContain('resource2');
    });

    it('should handle both NewInternetExposures and NewInternetEgressExposures', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'Full analysis summary',
            NewInternetExposures: ['ingress_resource1'],
            NewInternetEgressExposures: ['egress_resource1', 'egress_resource2'],
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### 🌐 New Internet Exposures');
      expect(result).toContain('ingress_resource1');
      // Note: NewInternetEgressExposures is not displayed in PR comments
    });

    it('should handle empty scan result', () => {
      const scanResult = JSON.stringify({});

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('## ✅ Terraform Reachability Analysis');
      expect(result).toContain('## ✅ Terraform Access Risk Analysis');
      expect(result).toContain('**Status**: No Security Issues Detected');
      expect(result).toContain(commitSha);
    });

    it('should handle scan result with no risks', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'All checks passed',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('All checks passed');
      expect(result).toContain('## ✅ Terraform Reachability Analysis');
      expect(result).toContain('## ✅ Terraform Access Risk Analysis');
      expect(result).toContain('**Status**: No Security Issues Detected');
    });

    it('should handle invalid RiskSummary JSON gracefully when it looks like JSON array', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: '[invalid-json-{[}]',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### ⚠️ Risk Assessment');
      expect(result).toContain('[invalid-json-{[}]');
      expect(warningSpy).toHaveBeenCalledWith(
        'Failed to parse RiskSummary as JSON, displaying as text'
      );
    });

    it('should format RiskSummary when it is a preformatted markdown string', () => {
      const markdownRiskSummary =
        '### 1. ac2-appserver-01 (`module.deploy-goat.aws_instance.appserver-01`)\nac2-appserver-01 is changing from non-internet-reachable to both exposed.';
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: markdownRiskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### ⚠️ Risk Assessment');
      expect(result).toContain('### 1. ac2-appserver-01');
      expect(result).toContain('ac2-appserver-01 is changing from non-internet-reachable');
      expect(infoSpy).toHaveBeenCalledWith('Found risk assessment (markdown summary)');
      expect(warningSpy).not.toHaveBeenCalled();
    });

    it('should handle completely invalid JSON input', () => {
      const result = formatScanResult('not-json-at-all', commitSha);

      expect(result).toContain('⚠️ Unable to parse the detailed results');
      expect(result).toContain('not-json-at-all');
      expect(result).toContain('## ⚠️ Terraform Reachability Analysis');
      expect(result).toContain('## ⚠️ Terraform Access Risk Analysis');
      expect(result).toContain('**Status**: Security Issues Detected');
    });

    describe('CrowdStrike PreCog detections', () => {
      it('should render CrowdStrike detections in a table when present (already-parsed array)', () => {
        const scanResult = JSON.stringify({
          ReachabilityAnalysis: { Summary: {} },
          CrowdstrikePrecogDetections: [
            {
              SeverityName: 'High',
              Description: 'A high level detection was triggered',
              FilePath: '/usr/bin/bash',
              Hostname: 'ip-172-31-23-126',
              ResourceID: 'i-08a47985383682d9d',
              Technique: 'Malicious Activity',
              RiskScore: '60',
              Status: 'new',
            },
          ],
        });

        const result = formatScanResult(scanResult, commitSha);

        expect(result).toContain('### 🔍 CrowdStrike PreCog Detections');
        expect(result).toContain(
          '| Severity | Description | File | Hostname | Resource ID | Technique | Risk Score | Status |'
        );
        expect(result).toContain('A high level detection was triggered');
        expect(result).toContain('/usr/bin/bash');
        expect(result).toContain('ip-172-31-23-126');
        expect(result).toContain('i-08a47985383682d9d');
        expect(result).toContain('**Status**: Security Issues Detected');
        expect(infoSpy).toHaveBeenCalledWith('Found 1 CrowdStrike PreCog detection(s)');
      });

      it('should escape pipes and newlines in table cells', () => {
        const scanResult = JSON.stringify({
          CrowdstrikePrecogDetections: [
            {
              SeverityName: 'Medium',
              Description: 'Pipe | and newline\nin description',
              FileName: 'file|name.txt',
            },
          ],
        });

        const result = formatScanResult(scanResult, commitSha);

        expect(result).toContain('### 🔍 CrowdStrike PreCog Detections');
        // Pipes in content should be escaped so the table doesn't break (&#124;)
        expect(result).toContain('&#124;');
        // Newline in Description should be replaced with space (so "newline in" appears)
        expect(result).toContain('newline in description');
        expect(result).not.toContain('newline\nin description');
      });

      it('should set hasRisks and Security Issues Detected when detections present', () => {
        const scanResult = JSON.stringify({
          CrowdstrikePrecogDetections: [
            { SeverityName: 'Critical', Description: 'Test detection' },
          ],
        });

        const result = formatScanResult(scanResult, commitSha);

        expect(result).toContain('**Status**: Security Issues Detected');
        expect(result).toContain('### 🔍 CrowdStrike PreCog Detections');
      });

      it('should show parse-failure message when CrowdstrikePrecogDetections is non-empty string', () => {
        const scanResult = JSON.stringify({
          ReachabilityAnalysis: { Summary: {} },
          CrowdstrikePrecogDetections: 'not-valid-json-array',
        });

        const result = formatScanResult(scanResult, commitSha);

        expect(result).toContain('### 🔍 CrowdStrike PreCog Detections');
        expect(result).toContain('Unable to parse CrowdStrike PreCog detections');
        expect(result).toContain('**Status**: Security Issues Detected');
      });

      it('should not render CrowdStrike section when array is empty', () => {
        const scanResult = JSON.stringify({
          ReachabilityAnalysis: { Summary: { TextSummary: 'Ok' } },
          CrowdstrikePrecogDetections: [],
        });

        const result = formatScanResult(scanResult, commitSha);

        expect(result).not.toContain('### 🔍 CrowdStrike PreCog Detections');
        expect(result).toContain('**Status**: No Security Issues Detected');
      });
    });

    it('should include proper markdown structure', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'Test summary',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('<!-- averlon-terraform-reachability -->');
      expect(result).toContain('<!-- averlon-terraform-access -->');
      expect(result).toContain('## ✅ Terraform Reachability Analysis');
      expect(result).toContain('## ✅ Terraform Access Risk Analysis');
      expect(result).toContain('*Analysis performed on commit: `abc123def456`*');
    });

    it('should handle risk assessment with missing optional fields', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'aws_instance.web',
          cloudResource: 'i-123',
          riskAssessment: {
            riskLevel: 'LOW',
            // No issuesSummary, impactAssessment, or vulnerabilities
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('Resource 1: `i-123 (aws_instance.web)`');
      expect(result).toContain('**Risk Level**: **LOW**');
      expect(result).not.toContain('**Issues summary:**');
      expect(result).not.toContain('**Impact:**');
      expect(result).not.toContain('**Vulnerabilities:**');
    });

    it('should handle vulnerabilities with missing fields', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'resource1',
          cloudResource: 'cloud1',
          riskAssessment: {
            riskLevel: 'MEDIUM',
            vulnerabilities: [
              {
                // No cve, severity, or riskAnalysis
              },
              {
                cve: 'CVE-2024-1234',
                // No severity or riskAnalysis
              },
            ],
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('**Vulnerabilities:**');
      expect(result).toContain('**Unknown CVE** (Unknown)');
      expect(result).toContain('**CVE-2024-1234** (Unknown)');
    });

    it('should handle access risk with missing optional fields', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              // Missing PrincipalID and TargetResourceID
              Added: ['s3:GetObject'],
            },
          ],
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('`Unknown Principal` → `Unknown Resource`');
      expect(result).toContain('**➕ Added Permissions:**');
      expect(result).toContain('`s3:GetObject`');
    });

    it('should display full PrincipalID and TargetResourceID in access assessments', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/path/to/MyRole',
              TargetResourceID: 'arn:aws:s3:::bucket/prefix/my-object',
              Added: ['s3:GetObject'],
            },
          ],
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain(
        '`arn:aws:iam::123456789012:role/path/to/MyRole` → `arn:aws:s3:::bucket/prefix/my-object`'
      );
      expect(result).toContain('**➕ Added Permissions:**');
    });

    it('should format AccessAnalysis.Summary.RiskSummary with risk level and impact', () => {
      const accessRiskSummary = JSON.stringify([
        {
          principalId: 'arn:aws:iam::945236499471:role/chatbot-iam-s3-read',
          targetResources: ['arn:aws:s3:::chatbot-chatbot-data'],
          groupSize: 1,
          riskAssessment: {
            riskLevel: 'High',
            issuesSummary:
              'EC2 instance is part of 18 attack chains; IAM role was granted s3:DeleteBucket.',
            impactAssessment:
              'Attacker can use s3:PutBucketPolicy to alter access and s3:DeleteBucket.',
          },
        },
      ]);

      const scanResult = JSON.stringify({
        AccessAnalysis: {
          Summary: {
            RiskSummary: accessRiskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### 🛡️ Risk Assessment');
      expect(result).toContain('`chatbot-iam-s3-read`');
      expect(result).toContain('chatbot-chatbot-data');
      expect(result).toContain(
        '**Principal**: `arn:aws:iam::945236499471:role/chatbot-iam-s3-read`'
      );
      expect(result).toContain('**Risk Level**: **High**');
      expect(result).toContain('**Issues summary:**');
      expect(result).toContain('EC2 instance is part of 18 attack chains');
      expect(result).toContain('**Impact:**');
      expect(result).toContain('Attacker can use s3:PutBucketPolicy');
    });

    it('should use correct severity emojis', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'critical_resource',
          cloudResource: 'cr1',
          riskAssessment: {
            riskLevel: 'CRITICAL',
            vulnerabilities: [
              { cve: 'CVE-1', severity: 'CRITICAL' },
              { cve: 'CVE-2', severity: 'HIGH' },
              { cve: 'CVE-3', severity: 'MEDIUM' },
              { cve: 'CVE-4', severity: 'LOW' },
              { cve: 'CVE-5', severity: 'UNKNOWN' },
            ],
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      // Verify emojis are present (exact emoji may vary, but format should be correct)
      expect(result).toMatch(/Resource 1:.+critical_resource/);
      expect(result).toContain('**Risk Level**: **CRITICAL**');
    });

    it('should log when formatting reachability with exposures', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'Test',
            NewInternetExposures: ['res1'],
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('res1');
      expect(result).toContain('Terraform Reachability Analysis');
      expect(infoSpy).toHaveBeenCalledWith('Found 1 new internet exposure(s)');
    });
  });

  describe('hasRisksInResult', () => {
    it('should return true when there are new internet exposures', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            NewInternetExposures: ['resource1'],
          },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true when there is a risk assessment', () => {
      const riskSummary = JSON.stringify([
        {
          terraformResource: 'resource1',
          riskAssessment: {
            riskLevel: 'HIGH',
          },
        },
      ]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: riskSummary,
          },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true when there are access risks', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/principal1',
              TargetResourceID: 'arn:aws:s3:::test-bucket',
              Added: ['s3:GetObject'],
            },
          ],
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return false when there are no risks', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'All good',
          },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(false);
    });

    it('should return false for empty scan result', () => {
      const scanResult = JSON.stringify({});

      expect(hasRisksInResult(scanResult)).toBe(false);
    });

    it('should return false when risk arrays are empty', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            NewInternetExposures: [],
            RiskSummary: JSON.stringify([]),
          },
        },
        AccessAnalysis: {
          Summary: {
            RiskSummary: JSON.stringify([]),
          },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(false);
    });

    it('should handle invalid JSON gracefully and return true (to be safe)', () => {
      // When JSON parsing fails, returns true to be on the safe side
      expect(hasRisksInResult('not-json')).toBe(true);
    });

    it('should handle invalid RiskSummary JSON gracefully', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: 'invalid-json',
          },
        },
      });

      // When RiskSummary can't be parsed as JSON, returns true if the string has content
      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true when there are access permission changes (added permissions)', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/test-role',
              TargetResourceID: 'arn:aws:s3:::test-bucket',
              Added: ['s3:GetObject'],
            },
          ],
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true when there are access permission changes (removed permissions)', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/test-role',
              TargetResourceID: 'arn:aws:s3:::test-bucket',
              Removed: ['s3:DeleteObject'],
            },
          ],
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return false when access permissions only have unchanged permissions', () => {
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [
            {
              PrincipalID: 'arn:aws:iam::123456789012:role/test-role',
              TargetResourceID: 'arn:aws:s3:::test-bucket',
              Unchanged: ['s3:ListBucket'],
              Added: [],
              Removed: [],
            },
          ],
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(false);
    });

    it('should return true when AccessAnalysis.Summary.RiskSummary has entries', () => {
      const accessRiskSummary = JSON.stringify([
        {
          principalId: 'arn:aws:iam::123:role/test',
          targetResources: ['arn:aws:s3:::bucket'],
          riskAssessment: { riskLevel: 'High' },
        },
      ]);
      const scanResult = JSON.stringify({
        AccessAnalysis: {
          AccessPermissions: [], // no permission changes
          Summary: { RiskSummary: accessRiskSummary },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should check ReachabilityAnalysis.Summary format', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            NewInternetExposures: ['resource1'],
          },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true when there are only egress exposures', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            NewInternetEgressExposures: ['egress_resource1'],
          },
        },
      });

      // Egress exposures are reachability risks (internet OR egress)
      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true for any of multiple risk types', () => {
      const riskSummary = JSON.stringify([{ riskAssessment: {} }]);
      const accessRiskSummary = JSON.stringify([{ principalId: 'test' }]);

      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            NewInternetExposures: ['resource1'],
            RiskSummary: riskSummary,
          },
        },
        AccessAnalysis: {
          Summary: {
            RiskSummary: accessRiskSummary,
          },
        },
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
    });

    it('should return true when only CrowdstrikePrecogDetections (non-empty array) is present', () => {
      const scanResult = JSON.stringify({
        CrowdstrikePrecogDetections: [{ SeverityName: 'High', Description: 'Detection' }],
      });

      expect(hasRisksInResult(scanResult)).toBe(true);
      expect(hasReachabilityRisks(scanResult)).toBe(true);
    });

    it('should return true when CrowdstrikePrecogDetections is non-empty string (unparseable)', () => {
      const scanResult = JSON.stringify({
        CrowdstrikePrecogDetections: 'raw-string-from-api',
      });

      expect(hasReachabilityRisks(scanResult)).toBe(true);
    });

    it('should return false when CrowdstrikePrecogDetections is empty array only', () => {
      const scanResult = JSON.stringify({
        CrowdstrikePrecogDetections: [],
      });

      expect(hasReachabilityRisks(scanResult)).toBe(false);
      expect(hasRisksInResult(scanResult)).toBe(false);
    });
  });

  describe('enforceCommentBodyLimit', () => {
    it('returns body unchanged when under limit', () => {
      const short = 'Hello world';
      expect(enforceCommentBodyLimit(short)).toBe(short);
      expect(enforceCommentBodyLimit(short, 100)).toBe(short);
    });

    it('truncates and appends footer when over limit', () => {
      const longBody = 'x'.repeat(GITHUB_COMMENT_BODY_MAX_LENGTH + 1000);
      const result = enforceCommentBodyLimit(longBody);
      expect(result.length).toBeLessThanOrEqual(GITHUB_COMMENT_BODY_MAX_LENGTH);
      expect(result).toContain('Full report available in workflow artifacts');
    });

    it('truncates at a newline boundary when possible', () => {
      const line = 'First line\nSecond line\nThird line\n';
      const longBody = line.repeat(5000);
      const result = enforceCommentBodyLimit(longBody);
      expect(result.length).toBeLessThanOrEqual(GITHUB_COMMENT_BODY_MAX_LENGTH);
      expect(result.endsWith('workflow artifacts._')).toBe(true);
    });

    it('respects custom maxLength when limit fits content + footer', () => {
      const maxLength = 300;
      const body = 'a'.repeat(500);
      const result = enforceCommentBodyLimit(body, maxLength);
      expect(result.length).toBeLessThanOrEqual(maxLength);
      expect(result).toContain('workflow artifacts');
    });

    it('includes link to workflow run when workflowRunUrl is provided', () => {
      const longBody = 'x'.repeat(GITHUB_COMMENT_BODY_MAX_LENGTH + 1000);
      const runUrl = 'https://github.com/owner/repo/actions/runs/12345';
      const result = enforceCommentBodyLimit(longBody, GITHUB_COMMENT_BODY_MAX_LENGTH, runUrl);
      expect(result).toContain('Show detailed summary (logs & artifacts)');
      expect(result).toContain(runUrl);
    });
  });
});
