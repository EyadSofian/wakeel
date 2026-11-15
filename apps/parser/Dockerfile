# syntax=docker/dockerfile:1
#
# The parser service (task 8.2, ADR-040). Build from apps/parser:
#
#   docker build -t wakeel-parser apps/parser
#
# Threat T10: it runs with no network and no credentials. Docling's layout and table models are
# downloaded at build time, so the running container never needs to reach Hugging Face.
ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2

FROM ${PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    HF_HOME=/opt/models
RUN pip install --no-cache-dir uv==0.11.26 \
 && useradd --system --uid 10001 --home-dir /app parser
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY tests/fixtures/table-page-break.pdf /tmp/warmup.pdf
# Fetch the models once, by converting a fixture here; then refuse to fetch at runtime.
RUN uv sync --frozen --no-dev \
 && uv run --no-sync python -c "from wakeel_parser.convert import convert, Limits; convert(open('/tmp/warmup.pdf','rb').read(), 'application/pdf', 'warmup', Limits(10**8, 10, 40))" \
 && rm /tmp/warmup.pdf \
 && chmod -R a+rX /opt/models
ENV HF_HUB_OFFLINE=1 \
    PATH=/app/.venv/bin:$PATH
USER parser
EXPOSE 4500
CMD ["uvicorn", "wakeel_parser.app:app", "--host", "0.0.0.0", "--port", "4500", "--app-dir", "src", "--no-server-header"]
