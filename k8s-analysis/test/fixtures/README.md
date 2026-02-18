# Helm template output fixtures

These YAML files simulate real `helm template` output (multi-document K8s manifests). They are used by `test/unit/deployment-metadata-from-helm.test.ts` to assert that metadata extraction works on the same structure the action sees in production.

- **helm-output-aws.yaml** – EKS-style: ConfigMap with `hub_region`/`cluster`, ServiceAccount with `eks.amazonaws.com/role-arn`.
- **helm-output-azure.yaml** – AKS-style: ConfigMap with `location`/`cluster` and AKS resource ID, Deployment with `kubernetes.azure.com/cluster` and topology labels.

To refresh from a real chart (optional):

```bash
helm template my-release ./path/to/chart --namespace demo -f values.yaml > test/fixtures/helm-output-aws.yaml
```
