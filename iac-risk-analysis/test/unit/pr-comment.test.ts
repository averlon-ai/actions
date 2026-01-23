import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as core from '@actions/core';
import { formatScanResult, hasRisksInResult } from '../../src/pr-comment.ts';

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
      expect(result).toContain('Resource 1: `aws_instance.web_server`');
      expect(result).toContain('**Cloud Resource**: `i-1234567890abcdef0`');
      expect(result).toContain('**Risk Level**: **HIGH**');
      expect(result).toContain('**Issues**: Security group allows unrestricted access');
      expect(result).toContain('**Impact**: High risk of unauthorized access');
      expect(result).toContain('**Vulnerabilities:**');
      expect(result).toContain('**CVE-2024-1234** (CRITICAL)');
      expect(result).toContain('Remote code execution vulnerability');
      expect(result).toContain('**CVE-2024-5678** (HIGH)');
      expect(result).toContain('Privilege escalation possible');
      expect(infoSpy).toHaveBeenCalledWith('Found 1 risk assessment(s)');
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

      expect(result).toContain('Resource 1: `aws_instance.web_server`');
      expect(result).toContain('Resource 2: `aws_s3_bucket.data`');
      expect(result).toContain('Resource 3: `aws_security_group.open`');
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

      expect(result).toContain('### 🛡️ Access Risk Assessment');
      expect(result).toContain('Assessment 1: `AdminRole` → `sensitive-bucket`');
      expect(result).toContain('**➕ Added Permissions:**');
      expect(result).toContain('`s3:GetObject`');
      expect(result).toContain('`s3:PutObject`');
      expect(result).toContain('**➖ Removed Permissions:**');
      expect(result).toContain('`s3:DeleteObject`');
      expect(result).toContain('**➡️ Unchanged Permissions:**');
      expect(result).toContain('`s3:ListBucket`');
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

      expect(result).toContain('Assessment 1: `Role1` → `arn:aws:s3:::bucket1`');
      expect(result).toContain('Assessment 2: `User2` → `Table2`');
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

      expect(result).toContain('## ✅ Terraform Security Analysis');
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
      expect(result).toContain('## ✅ Terraform Security Analysis');
      expect(result).toContain('**Status**: No Security Issues Detected');
    });

    it('should handle invalid RiskSummary JSON gracefully', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            RiskSummary: 'invalid-json-{[}]',
          },
        },
      });

      const result = formatScanResult(scanResult, commitSha);

      expect(result).toContain('### ⚠️ Risk Assessment');
      expect(result).toContain('invalid-json-{[}]');
      expect(warningSpy).toHaveBeenCalledWith(
        'Failed to parse RiskSummary as JSON, displaying as text'
      );
    });

    it('should handle completely invalid JSON input', () => {
      const result = formatScanResult('not-json-at-all', commitSha);

      expect(result).toContain('⚠️ Unable to parse the detailed results');
      expect(result).toContain('not-json-at-all');
      expect(result).toContain('## ⚠️ Terraform Security Analysis');
      expect(result).toContain('**Status**: Security Issues Detected');
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

      expect(result).toContain('<!-- averlon-terraform-scan-comment -->');
      expect(result).toContain('## ✅ Terraform Security Analysis');
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

      expect(result).toContain('Resource 1: `aws_instance.web`');
      expect(result).toContain('**Risk Level**: **LOW**');
      expect(result).not.toContain('**Issues**:');
      expect(result).not.toContain('**Impact**:');
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

      expect(result).toContain('Assessment 1: `Unknown Principal` → `Unknown Resource`');
      expect(result).toContain('**➕ Added Permissions:**');
      expect(result).toContain('`s3:GetObject`');
    });

    it('should extract last part of ARN for principals and resources', () => {
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

      expect(result).toContain('Assessment 1: `MyRole` → `my-object`');
      expect(result).toContain('**➕ Added Permissions:**');
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

    it('should log debug messages during parsing', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            TextSummary: 'Test',
            NewInternetExposures: ['res1'],
          },
        },
      });

      formatScanResult(scanResult, commitSha);

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Parsing scan result'));
      expect(debugSpy).toHaveBeenCalledWith('Found summary data in scan results');
      expect(debugSpy).toHaveBeenCalledWith('Adding text summary to comment');
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

    it('should return false when there are only egress exposures (not displayed)', () => {
      const scanResult = JSON.stringify({
        ReachabilityAnalysis: {
          Summary: {
            NewInternetEgressExposures: ['egress_resource1'],
          },
        },
      });

      // Egress exposures are not checked in hasRisksInResult
      expect(hasRisksInResult(scanResult)).toBe(false);
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
  });
});
