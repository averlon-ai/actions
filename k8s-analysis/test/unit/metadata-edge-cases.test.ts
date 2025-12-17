import { describe, it, expect } from 'bun:test';
import { parseHelmManifest } from '../../src/resource-parser';

describe('Metadata Extraction Edge Cases', () => {
  describe('Invalid or Malformed Data', () => {
    it('should handle resources with empty spec', () => {
      const yaml = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: empty-config`;

      const resources = parseHelmManifest(yaml);

      expect(resources.length).toBe(1);
      expect(resources[0].metadata).toBeDefined();
    });

    it('should handle malformed ARNs gracefully', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: INVALID_ARN
              value: "not-an-arn"
            - name: PARTIAL_ARN
              value: "arn:aws:iam::"`;

      const resources = parseHelmManifest(yaml);

      // Should not extract invalid ARNs
      expect(resources[0].metadata?.referencedArns).toBeUndefined();
    });

    it('should handle zone labels that do not match expected pattern', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    topology.kubernetes.io/zone: invalid-zone-format
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      // Should not extract region from invalid zone format
      expect(resources[0].metadata?.region).toBeUndefined();
      expect(resources[0].metadata?.zone).toBe('invalid-zone-format');
    });

    it('should handle numeric values in metadata', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  replicas: "not-a-number"`;

      const resources = parseHelmManifest(yaml);

      // Should not crash, replicas should be undefined or NaN
      expect(resources[0].metadata).toBeDefined();
    });
  });

  describe('Missing or Null Values', () => {
    it('should handle containers without images', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: app`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.containerNames).toEqual(['app']);
      expect(resources[0].metadata?.images).toEqual([]);
    });

    it('should handle envFrom without refs', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          envFrom: []`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata).toBeDefined();
    });

    it('should handle volumes without configMap or secret', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  volumes:
    - name: empty-dir
      emptyDir: {}
  containers:
    - name: app
      image: nginx:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs).toBeUndefined();
      expect(resources[0].metadata?.secretRefs).toBeUndefined();
    });

    it('should handle selector without matchLabels', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  replicas: 1
  selector: {}`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.selector).toBeUndefined();
    });
  });

  describe('Special Characters and Encoding', () => {
    it('should handle resource names with special characters', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: my-service-v1.2.3
  namespace: test-ns
spec:
  type: ClusterIP`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].name).toBe('my-service-v1.2.3');
      expect(resources[0].namespace).toBe('test-ns');
    });

    it('should handle ARNs with special characters', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: S3_ARN
              value: "arn:aws:s3:us-east-1:123456789012:bucket/my-bucket/path/to/file.txt"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:s3:us-east-1:123456789012:bucket/my-bucket/path/to/file.txt'
      );
    });

    it('should handle labels with dots and slashes', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    app.kubernetes.io/name: myapp
    app.kubernetes.io/version: v1.0.0
    topology.kubernetes.io/region: us-west-2
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].labels['app.kubernetes.io/name']).toBe('myapp');
      expect(resources[0].metadata?.region).toBe('us-west-2');
    });
  });

  describe('Large and Complex Resources', () => {
    it('should handle resources with many containers', () => {
      const containers = Array.from(
        { length: 20 },
        (_, i) => `
        - name: container-${i}
          image: image-${i}:latest`
      ).join('');

      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multi-container-app
spec:
  template:
    spec:
      containers:${containers}`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.images?.length).toBe(20);
      expect(resources[0].metadata?.containerNames?.length).toBe(20);
    });

    it('should handle resources with many environment variables', () => {
      const envVars = Array.from(
        { length: 50 },
        (_, i) => `
            - name: VAR_${i}
              value: "value-${i}"`
      ).join('');

      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: many-env-vars
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:${envVars}`;

      const resources = parseHelmManifest(yaml);

      expect(resources.length).toBe(1);
      expect(resources[0].metadata).toBeDefined();
    });

    it('should handle resources with many ConfigMap references', () => {
      const configMapRefs = Array.from(
        { length: 15 },
        (_, i) => `
            - configMapRef:
                name: config-${i}`
      ).join('');

      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: many-configs
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          envFrom:${configMapRefs}`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs?.length).toBe(15);
    });

    it('should handle multiple ARNs in same env var value', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: MULTIPLE_ARNS
              value: "arn:aws:iam::123456789012:role/role1 arn:aws:sqs:us-west-2:123456789012:queue1 arn:aws:sns:us-west-2:123456789012:topic1"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns?.length).toBe(3);
    });
  });

  describe('Resource Type Specific Cases', () => {
    it('should extract service-specific metadata for LoadBalancer', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: lb-service
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb
  ports:
    - port: 443
      targetPort: 8443`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.serviceType).toBe('LoadBalancer');
      expect(resources[0].metadata?.loadBalancerClass).toBe('service.k8s.aws/nlb');
    });

    it('should extract storage class from StatefulSet volumeClaimTemplates', () => {
      const yaml = `---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database
spec:
  serviceName: database
  replicas: 3
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        storageClassName: fast-ssd
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 100Gi
    - metadata:
        name: logs
      spec:
        storageClassName: standard`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.volumeClaims).toContain('data');
      expect(resources[0].metadata?.volumeClaims).toContain('logs');
    });

    it('should handle CronJob container extraction', () => {
      const yaml = `---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-job
spec:
  schedule: "0 0 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: backup-tool:v1`;

      const resources = parseHelmManifest(yaml);

      // CronJob has nested template structure
      expect(resources.length).toBe(1);
    });

    it('should handle DaemonSet correctly', () => {
      const yaml = `---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  labels:
    topology.kubernetes.io/region: us-west-2
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    spec:
      containers:
        - name: exporter
          image: prom/node-exporter:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].kind).toBe('DaemonSet');
      expect(resources[0].metadata?.region).toBe('us-west-2');
      expect(resources[0].metadata?.images).toContain('prom/node-exporter:latest');
    });
  });

  describe('Duplicate and Conflicting Data', () => {
    it('should deduplicate identical ConfigMap references', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      volumes:
        - name: config1
          configMap:
            name: app-config
        - name: config2
          configMap:
            name: app-config
      containers:
        - name: app
          image: nginx:latest
          envFrom:
            - configMapRef:
                name: app-config`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs?.length).toBe(1);
      expect(resources[0].metadata?.configMapRefs).toEqual(['app-config']);
    });

    it('should deduplicate identical ARNs', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    role: "arn:aws:iam::123456789012:role/app-role"
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: ROLE1
              value: "arn:aws:iam::123456789012:role/app-role"
            - name: ROLE2
              value: "arn:aws:iam::123456789012:role/app-role"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns?.length).toBe(1);
    });

    it('should handle conflicting region data gracefully', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    topology.kubernetes.io/region: us-west-2
    topology.kubernetes.io/zone: eu-central-1a
  annotations:
    aws.amazon.com/region: ap-south-1
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      // Should prefer label over annotation
      expect(resources[0].metadata?.region).toBe('us-west-2');
      expect(resources[0].metadata?.awsRegion).toBe('ap-south-1');
    });
  });

  describe('Unicode and International Characters', () => {
    it('should handle resource names with unicode characters', () => {
      const yaml = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-测试
data:
  key: value`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].name).toBe('config-测试');
    });

    it('should handle values with emoji and special unicode', () => {
      const yaml = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: test-config
  annotations:
    description: "Service 🚀 for testing"
data:
  message: "Hello 世界"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].annotations['description']).toBe('Service 🚀 for testing');
    });
  });

  describe('Boundary Conditions', () => {
    it('should handle replica count of 0', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scaled-down
spec:
  replicas: 0
  selector:
    matchLabels:
      app: test`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.replicas).toBe(0);
    });

    it('should handle very large replica counts', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: massive-scale
spec:
  replicas: 10000
  selector:
    matchLabels:
      app: test`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.replicas).toBe(10000);
    });

    it('should handle empty arrays', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers: []`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.images).toEqual([]);
      expect(resources[0].metadata?.containerNames).toEqual([]);
    });
  });

  describe('Real-World Complex Scenarios', () => {
    it('should handle a production-like deployment with all metadata', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: production-web-app
  namespace: production
  uid: prod-123-456
  resourceVersion: "987654"
  generation: 5
  labels:
    app: web
    tier: frontend
    environment: production
    topology.kubernetes.io/region: us-west-2
    topology.kubernetes.io/zone: us-west-2a
    cluster: prod-us-west-2
    version: v2.1.5
  annotations:
    deployment.kubernetes.io/revision: "5"
    aws.amazon.com/account-id: "123456789012"
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/prod-web-role"
spec:
  replicas: 10
  selector:
    matchLabels:
      app: web
      tier: frontend
  template:
    spec:
      serviceAccountName: web-sa
      volumes:
        - name: config
          configMap:
            name: web-config-v2
        - name: secrets
          secret:
            secretName: web-secrets
        - name: cache
          persistentVolumeClaim:
            claimName: web-cache-pvc
      containers:
        - name: web
          image: myorg/web-app:v2.1.5
          ports:
            - containerPort: 8080
          env:
            - name: AWS_REGION
              value: "us-west-2"
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
            - name: SQS_QUEUE_URL
              value: "https://sqs.us-west-2.amazonaws.com/123456789012/prod-queue"
            - name: DYNAMODB_TABLE
              value: "arn:aws:dynamodb:us-west-2:123456789012:table/prod-data"
          envFrom:
            - configMapRef:
                name: web-env-config
            - secretRef:
                name: web-env-secrets
        - name: sidecar-proxy
          image: envoyproxy/envoy:v1.20.0
        - name: log-forwarder
          image: fluent/fluent-bit:1.8
      initContainers:
        - name: migrate
          image: migrate/migrate:v4
          env:
            - name: DB_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url`;

      const resources = parseHelmManifest(yaml);
      const metadata = resources[0].metadata;

      // Verify comprehensive extraction
      expect(metadata?.uid).toBe('prod-123-456');
      expect(metadata?.resourceVersion).toBe('987654');
      expect(metadata?.generation).toBe(5);
      expect(metadata?.region).toBe('us-west-2');
      expect(metadata?.zone).toBe('us-west-2a');
      expect(metadata?.cluster).toBe('prod-us-west-2');
      expect(metadata?.accountId).toBe('123456789012');
      expect(metadata?.replicas).toBe(10);
      expect(metadata?.images?.length).toBe(4);
      expect(metadata?.containerNames?.length).toBe(4);
      expect(metadata?.configMapRefs).toContain('web-config-v2');
      expect(metadata?.configMapRefs).toContain('web-env-config');
      expect(metadata?.secretRefs).toContain('web-secrets');
      expect(metadata?.secretRefs).toContain('db-credentials');
      expect(metadata?.secretRefs).toContain('web-env-secrets');
      expect(metadata?.volumeClaims).toContain('web-cache-pvc');
      expect(metadata?.referencedArns?.length).toBeGreaterThanOrEqual(2);
    });
  });
});
