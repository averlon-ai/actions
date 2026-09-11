#!/usr/bin/env bash
#
# Resolves the agent model and, on Bedrock, checks the credentials
# claude-code-action requires.
#
# Required environment: MODEL, USE_BEDROCK, GITHUB_OUTPUT

set -euo pipefail

DEFAULT_MODEL=claude-opus-5
DEFAULT_BEDROCK_MODEL=us.anthropic.claude-opus-5

# Sets MODEL_RESOLVED rather than printing it, so that the workflow command
# below reaches the log instead of a substitution.
resolve_bedrock_model() {
  if [ -z "${MODEL:-}" ]; then
    MODEL_RESOLVED=$DEFAULT_BEDROCK_MODEL
    return 0
  fi

  case "$MODEL" in
    *anthropic.*)
      MODEL_RESOLVED=$MODEL
      ;;
    *)
      echo "::error::model '$MODEL' is not a Bedrock model id. With use-bedrock, set model to a Bedrock model or inference profile id, for example '$DEFAULT_BEDROCK_MODEL'."
      return 1
      ;;
  esac
}

check_bedrock_credentials() {
  if [ -z "${AWS_REGION:-}" ]; then
    echo "::error::AWS_REGION is not set. Set it in the workflow env so the Bedrock endpoint can be resolved."
    return 1
  fi

  if [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
    return 0
  fi

  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    return 0
  fi

  echo "::error::No AWS credentials in the environment. The Coding Agent needs AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. An instance or pod IAM role alone is not enough - assume it in a step such as aws-actions/configure-aws-credentials first."
  return 1
}

main() {
  if [ "${USE_BEDROCK:-false}" = "true" ]; then
    resolve_bedrock_model
    check_bedrock_credentials
  else
    MODEL_RESOLVED=${MODEL:-$DEFAULT_MODEL}
  fi

  echo "Coding Agent model: $MODEL_RESOLVED"
  echo "model=$MODEL_RESOLVED" >> "$GITHUB_OUTPUT"
}

main "$@"
