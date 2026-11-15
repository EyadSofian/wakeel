# TEI and the model are pinned separately; the model id is deployment configuration from the registry.
FROM ghcr.io/huggingface/text-embeddings-inference@sha256:8419f533857b503ebf6ec292a95d4f1cf9c0464ac8b8abeef39518cf110e5726
ENV PORT=8080 HOSTNAME=0.0.0.0 DTYPE=float32 MAX_CLIENT_BATCH_SIZE=30 MAX_CONCURRENT_REQUESTS=2 MAX_BATCH_TOKENS=8192 TOKENIZATION_WORKERS=2 DISABLE_SPANS=true
# Upstream logs its Args structure at info, including API_KEY; never enable info/debug on this image.
ENV LOG_LEVEL=error
