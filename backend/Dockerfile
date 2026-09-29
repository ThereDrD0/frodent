FROM ghcr.io/astral-sh/uv:0.12.18 AS uvbin

FROM python:3.12.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/backend/.venv/bin:$PATH"
WORKDIR /app
COPY --from=uvbin /uv /uvx /usr/local/bin/
COPY backend/pyproject.toml backend/uv.lock ./backend/
RUN cd /app/backend && uv sync --frozen --no-dev --no-install-project
COPY backend/ryadom_backend ./backend/ryadom_backend
RUN mkdir -p /var/lib/ryadom/board-files && chown -R 10001:10001 /app /var/lib/ryadom
USER 10001:10001
WORKDIR /app/backend
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "ryadom_backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
