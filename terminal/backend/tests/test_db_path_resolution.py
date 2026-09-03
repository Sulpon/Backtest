"""
app.db._resolve_db_filename() - the VERCEL-env-based switch between the
full local data.duckdb and the small, production-only data.deploy.duckdb.
Tests the pure function directly rather than reloading app.db (which
would touch the module-level DB_PATH/_base_con singleton every other test
in this suite shares - see that module's own docstring on why).
"""
from app.db import _resolve_db_filename


def test_defaults_to_the_full_local_database_when_vercel_is_unset(monkeypatch):
    monkeypatch.delenv("VERCEL", raising=False)
    assert _resolve_db_filename() == "data.duckdb"


def test_switches_to_the_deploy_database_when_vercel_is_set(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    assert _resolve_db_filename() == "data.deploy.duckdb"
