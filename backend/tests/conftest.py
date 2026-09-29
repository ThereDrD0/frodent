import os
import tempfile
import uuid
import asyncio

import pytest
import httpx

os.environ.setdefault("JWT_SECRET", "tests-only-secret-that-is-not-for-deployment-1234567890")


@pytest.fixture(scope="session")
def api():
    database_url = os.environ.get("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Для API/БД нужен TEST_DATABASE_URL; используйте scripts/test-backend.sh.")
    if "ryadom_test" not in database_url:
        pytest.fail("Интеграционные тесты разрешены только для явно изолированной БД с именем ryadom_test.")
    from ryadom_backend.config import Settings
    from ryadom_backend.database import create_pool, migrate
    from ryadom_backend.main import create_app

    with tempfile.TemporaryDirectory(prefix="ryadom-api-test-") as file_root:
        settings = Settings(
            database_url=database_url,
            jwt_secret="tests-only-secret-that-is-not-for-deployment-1234567890",
            public_app_url="http://127.0.0.1:4173",
            allowed_origins=frozenset({"http://127.0.0.1:4173"}),
            file_root=__import__("pathlib").Path(file_root),
            admin_email="root@example.test",
            admin_setup_token="tests-only-admin-setup-token-123456789",
        )
        pool = create_pool(database_url)
        pool.open(wait=True)
        migrate(pool)
        application = create_app(settings, pool=pool)
        settings.file_root.mkdir(parents=True, exist_ok=True)
        yield SyncASGIClient(application)
        pool.close()


class SyncASGIClient:
    """Small synchronous test facade over an in-process ASGI client."""

    def __init__(self, app):
        self.app = app

    def request(self, method, url, **options):
        async def send():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://testserver") as client:
                return await client.request(method, url, **options)
        return asyncio.run(send())

    def get(self, url, **options): return self.request("GET", url, **options)
    def post(self, url, **options): return self.request("POST", url, **options)
    def patch(self, url, **options): return self.request("PATCH", url, **options)
    def delete(self, url, **options): return self.request("DELETE", url, **options)


@pytest.fixture
def account(api):
    email = f"user-{uuid.uuid4()}@example.test"
    response = api.post("/api/v1/auth/register", json={"email": email, "password": "secure-test-password", "displayName": "Тестовый участник"})
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    return {"email": email, **data, "headers": {"Authorization": f"Bearer {data['access_token']}"}}


def auth_headers(account):
    return {"Authorization": f"Bearer {account['access_token']}"}
