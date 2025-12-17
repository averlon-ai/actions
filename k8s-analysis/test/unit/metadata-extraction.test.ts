import { describe, it, expect } from 'bun:test';
import { parseHelmManifest } from '../../src/resource-parser';

describe('Comprehensive Metadata Extraction', () => {
  describe('Topology and Location Metadata', () => {
    it('should extract region from standard topology label', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  namespace: production
  labels:
    topology.kubernetes.io/region: us-west-2
spec:
  replicas: 3`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.region).toBe('us-west-2');
    });

    it('should extract region from legacy topology label', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    failure-domain.beta.kubernetes.io/region: eu-central-1
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.region).toBe('eu-central-1');
    });

    it('should extract region from zone label', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    topology.kubernetes.io/zone: us-west-2a
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.region).toBe('us-west-2');
      expect(resources[0].metadata?.zone).toBe('us-west-2a');
    });

    it('should extract cluster from standard label', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    cluster: prod-cluster
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.cluster).toBe('prod-cluster');
    });

    it('should extract cluster from EKS annotation', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    eks.amazonaws.com/cluster-name: prod-eks-cluster
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.cluster).toBe('prod-eks-cluster');
    });

    it('should prioritize region label over zone extraction', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    topology.kubernetes.io/region: us-east-1
    topology.kubernetes.io/zone: us-west-2a
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.region).toBe('us-east-1');
    });
  });

  describe('AWS-Specific Metadata', () => {
    it('should extract AWS account ID from annotation', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    aws.amazon.com/account-id: "123456789012"
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.accountId).toBe('123456789012');
    });

    it('should extract AWS region from annotation', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    aws.amazon.com/region: us-west-2
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.awsRegion).toBe('us-west-2');
    });

    it('should extract ARNs from annotations', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: test-service
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-arn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/my-lb/abc123"
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/my-role"
spec:
  type: LoadBalancer`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns).toBeDefined();
      expect(resources[0].metadata?.referencedArns?.length).toBe(2);
      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/my-lb/abc123'
      );
      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:iam::123456789012:role/my-role'
      );
    });

    it('should extract account ID from ARNs', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    iam-role: "arn:aws:iam::987654321098:role/app-role"
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.accountId).toBe('987654321098');
    });
  });

  describe('Container and Image Metadata', () => {
    it('should extract container names and images from Deployment', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.19
        - name: sidecar
          image: envoyproxy/envoy:v1.18.0
      initContainers:
        - name: init
          image: busybox:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.containerNames).toEqual(['app', 'sidecar', 'init']);
      expect(resources[0].metadata?.images).toEqual([
        'nginx:1.19',
        'envoyproxy/envoy:v1.18.0',
        'busybox:latest',
      ]);
    });

    it('should extract container names and images from Pod', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: web
      image: nginx:alpine
    - name: logger
      image: fluent/fluent-bit:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.containerNames).toEqual(['web', 'logger']);
      expect(resources[0].metadata?.images).toEqual(['nginx:alpine', 'fluent/fluent-bit:latest']);
    });

    it('should deduplicate container images', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
spec:
  template:
    spec:
      containers:
        - name: app1
          image: nginx:1.19
        - name: app2
          image: nginx:1.19`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.images?.length).toBe(1);
      expect(resources[0].metadata?.images).toEqual(['nginx:1.19']);
    });
  });

  describe('Service and Network Metadata', () => {
    it('should extract service type and name', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: web-service
spec:
  type: LoadBalancer
  ports:
    - port: 80`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.serviceName).toBe('web-service');
      expect(resources[0].metadata?.serviceType).toBe('LoadBalancer');
    });

    it('should extract load balancer class', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: nlb-service
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.loadBalancerClass).toBe('service.k8s.aws/nlb');
    });

    it('should extract ingress class from annotation', () => {
      const yaml = `---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: test-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: example.com`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.ingressClass).toBe('nginx');
    });

    it('should extract ingress class from ingressClassName annotation', () => {
      const yaml = `---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: test-ingress
  annotations:
    ingressClassName: alb
spec:
  rules:
    - host: example.com`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.ingressClass).toBe('alb');
    });
  });

  describe('Storage Metadata', () => {
    it('should extract storage class from PVC', () => {
      const yaml = `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
spec:
  storageClassName: gp3
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.storageClass).toBe('gp3');
    });

    it('should extract volume claims from Pod', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: data-pvc
    - name: cache
      persistentVolumeClaim:
        claimName: cache-pvc
  containers:
    - name: app
      image: nginx:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.volumeClaims).toEqual(['data-pvc', 'cache-pvc']);
    });

    it('should extract volume claim templates from StatefulSet', () => {
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
        storageClassName: gp3
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 100Gi`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.volumeClaims).toContain('data');
    });
  });

  describe('ConfigMap and Secret References', () => {
    it('should extract ConfigMap references from volumes', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  volumes:
    - name: config
      configMap:
        name: app-config
    - name: settings
      configMap:
        name: app-settings
  containers:
    - name: app
      image: nginx:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs).toEqual(['app-config', 'app-settings']);
    });

    it('should extract Secret references from volumes', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  volumes:
    - name: secret
      secret:
        secretName: app-secret
  containers:
    - name: app
      image: nginx:latest`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.secretRefs).toEqual(['app-secret']);
    });

    it('should extract ConfigMap references from env vars', () => {
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
            - name: CONFIG_VALUE
              valueFrom:
                configMapKeyRef:
                  name: app-config
                  key: value`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs).toContain('app-config');
    });

    it('should extract Secret references from env vars', () => {
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
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: password`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.secretRefs).toContain('db-secret');
    });

    it('should extract ConfigMap references from envFrom', () => {
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
          envFrom:
            - configMapRef:
                name: env-config`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs).toContain('env-config');
    });

    it('should extract Secret references from envFrom', () => {
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
          envFrom:
            - secretRef:
                name: env-secret`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.secretRefs).toContain('env-secret');
    });

    it('should deduplicate ConfigMap and Secret references', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      volumes:
        - name: config-vol
          configMap:
            name: app-config
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: CONFIG
              valueFrom:
                configMapKeyRef:
                  name: app-config
                  key: value
          envFrom:
            - configMapRef:
                name: app-config`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.configMapRefs?.length).toBe(1);
      expect(resources[0].metadata?.configMapRefs).toEqual(['app-config']);
    });
  });

  describe('ARN Extraction from Environment Variables', () => {
    it('should extract IAM role ARNs from env vars', () => {
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
            - name: AWS_ROLE_ARN
              value: "arn:aws:iam::123456789012:role/app-role"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:iam::123456789012:role/app-role'
      );
    });

    it('should extract multiple ARNs from different env vars', () => {
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
            - name: SQS_QUEUE_ARN
              value: "arn:aws:sqs:us-west-2:123456789012:my-queue"
            - name: SNS_TOPIC_ARN
              value: "arn:aws:sns:us-west-2:123456789012:my-topic"
            - name: LAMBDA_ARN
              value: "arn:aws:lambda:us-west-2:123456789012:function:my-function"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns?.length).toBe(3);
      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:sqs:us-west-2:123456789012:my-queue'
      );
      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:sns:us-west-2:123456789012:my-topic'
      );
      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:lambda:us-west-2:123456789012:function:my-function'
      );
    });

    it('should extract DynamoDB table ARNs', () => {
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
            - name: DYNAMODB_TABLE_ARN
              value: "arn:aws:dynamodb:us-west-2:123456789012:table/my-table"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns).toContain(
        'arn:aws:dynamodb:us-west-2:123456789012:table/my-table'
      );
    });

    it('should extract account ID from ARNs in env vars', () => {
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
            - name: AWS_ROLE_ARN
              value: "arn:aws:iam::987654321098:role/app-role"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.accountId).toBe('987654321098');
    });

    it('should handle S3 ARNs (which do not match standard pattern)', () => {
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
            - name: S3_BUCKET
              value: "arn:aws:s3:::my-bucket"`;

      const resources = parseHelmManifest(yaml);

      // S3 ARNs use standard format without account ID (arn:aws:s3:::bucket)
      expect(resources[0].metadata?.referencedArns).toContain('arn:aws:s3:::my-bucket');
    });

    it('should deduplicate ARNs from env vars and annotations', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    iam-role: "arn:aws:iam::123456789012:role/app-role"
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: AWS_ROLE_ARN
              value: "arn:aws:iam::123456789012:role/app-role"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.referencedArns?.length).toBe(1);
    });
  });

  describe('Owner References', () => {
    it('should extract owner references', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: nginx-deployment-66b6c48dd5
      uid: d9607e19-f88f-11e6-a518-42010a800195
      controller: true`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.ownerReferences).toBeDefined();
      expect(resources[0].metadata?.ownerReferences?.length).toBe(1);
      expect(resources[0].metadata?.ownerReferences?.[0]).toEqual({
        kind: 'ReplicaSet',
        name: 'nginx-deployment-66b6c48dd5',
        uid: 'd9607e19-f88f-11e6-a518-42010a800195',
      });
    });

    it('should handle multiple owner references', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: rs-1
      uid: uid-1
    - apiVersion: apps/v1
      kind: Deployment
      name: deploy-1
      uid: uid-2`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.ownerReferences?.length).toBe(2);
    });
  });

  describe('Replica Information', () => {
    it('should extract replica count from Deployment', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
spec:
  replicas: 5
  selector:
    matchLabels:
      app: myapp`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.replicas).toBe(5);
    });

    it('should extract selector match labels', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: v1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.selector).toEqual({
        app: 'myapp',
        version: 'v1',
      });
    });

    it('should extract replica count from StatefulSet', () => {
      const yaml = `---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database
spec:
  serviceName: database
  replicas: 3
  selector:
    matchLabels:
      app: db`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.replicas).toBe(3);
    });
  });

  describe('Core Kubernetes Metadata', () => {
    it('should extract UID', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  uid: 123e4567-e89b-12d3-a456-426614174000`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.uid).toBe('123e4567-e89b-12d3-a456-426614174000');
    });

    it('should extract resource version', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  resourceVersion: "12345"`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.resourceVersion).toBe('12345');
    });

    it('should extract generation', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
  generation: 3
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.generation).toBe(3);
    });
  });

  describe('Complete Metadata Extraction', () => {
    it('should extract all metadata from a comprehensive resource', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: production
  uid: abc-123
  resourceVersion: "456"
  generation: 2
  labels:
    app: web
    topology.kubernetes.io/region: us-west-2
    topology.kubernetes.io/zone: us-west-2a
    cluster: prod-cluster
  annotations:
    aws.amazon.com/account-id: "123456789012"
    deployment.kubernetes.io/revision: "2"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    spec:
      volumes:
        - name: config
          configMap:
            name: web-config
        - name: secret
          secret:
            secretName: web-secret
        - name: data
          persistentVolumeClaim:
            claimName: data-pvc
      containers:
        - name: web
          image: myorg/web:v1.2.3
          env:
            - name: AWS_ROLE_ARN
              value: "arn:aws:iam::123456789012:role/web-role"
            - name: SQS_QUEUE_ARN
              value: "arn:aws:sqs:us-west-2:123456789012:my-queue"
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: password
          envFrom:
            - configMapRef:
                name: env-config
        - name: sidecar
          image: envoy:v1.18.0`;

      const resources = parseHelmManifest(yaml);
      const metadata = resources[0].metadata;

      // Core metadata
      expect(metadata?.uid).toBe('abc-123');
      expect(metadata?.resourceVersion).toBe('456');
      expect(metadata?.generation).toBe(2);

      // Topology
      expect(metadata?.region).toBe('us-west-2');
      expect(metadata?.zone).toBe('us-west-2a');
      expect(metadata?.cluster).toBe('prod-cluster');

      // AWS
      expect(metadata?.accountId).toBe('123456789012');

      // Containers
      expect(metadata?.images).toEqual(['myorg/web:v1.2.3', 'envoy:v1.18.0']);
      expect(metadata?.containerNames).toEqual(['web', 'sidecar']);

      // Replicas
      expect(metadata?.replicas).toBe(3);
      expect(metadata?.selector).toEqual({ app: 'web' });

      // ConfigMaps and Secrets
      expect(metadata?.configMapRefs).toContain('web-config');
      expect(metadata?.configMapRefs).toContain('env-config');
      expect(metadata?.secretRefs).toContain('web-secret');
      expect(metadata?.secretRefs).toContain('db-secret');

      // Volume claims
      expect(metadata?.volumeClaims).toContain('data-pvc');

      // Referenced ARNs
      expect(metadata?.referencedArns).toContain('arn:aws:iam::123456789012:role/web-role');
      expect(metadata?.referencedArns).toContain('arn:aws:sqs:us-west-2:123456789012:my-queue');
    });

    it('should handle resources with minimal metadata', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: simple-service
spec:
  type: ClusterIP
  ports:
    - port: 80`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata).toBeDefined();
      expect(resources[0].metadata?.serviceType).toBe('ClusterIP');
      expect(resources[0].metadata?.serviceName).toBe('simple-service');
    });

    it('should handle resources with no extractable metadata', () => {
      const yaml = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: simple-config
data:
  key: value`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata).toBeDefined();
      // ConfigMap doesn't have most metadata fields, should not error
    });
  });
});
