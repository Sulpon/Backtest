"""
fetch_db.py's remove_full_db_if_present() - the safety-gated deletion of
the full data.duckdb that keeps it out of the packaged Vercel function
(see that module's docstring: vercel.json's excludeFiles alone proved
unreliable for this in a real deploy). The VERCEL-env gate is the whole
point of these tests: this function is destructive, and must never fire
outside an actual Vercel build.
"""
import os

import fetch_db


def test_does_nothing_when_vercel_is_unset_even_if_the_file_exists(tmp_path, monkeypatch):
    fake_full_db = tmp_path / "data.duckdb"
    fake_full_db.write_bytes(b"pretend this is a real 499MB database")
    monkeypatch.setattr(fetch_db, "FULL_DB_PATH", str(fake_full_db))
    monkeypatch.delenv("VERCEL", raising=False)

    fetch_db.remove_full_db_if_present()

    assert fake_full_db.exists(), "must never delete the full database outside an actual Vercel build"


def test_removes_the_file_when_vercel_is_set(tmp_path, monkeypatch):
    fake_full_db = tmp_path / "data.duckdb"
    fake_full_db.write_bytes(b"pretend this is a real 499MB database")
    monkeypatch.setattr(fetch_db, "FULL_DB_PATH", str(fake_full_db))
    monkeypatch.setenv("VERCEL", "1")

    fetch_db.remove_full_db_if_present()

    assert not fake_full_db.exists()


def test_is_a_no_op_when_vercel_is_set_but_the_file_never_existed(tmp_path, monkeypatch):
    missing_path = tmp_path / "data.duckdb"
    monkeypatch.setattr(fetch_db, "FULL_DB_PATH", str(missing_path))
    monkeypatch.setenv("VERCEL", "1")

    fetch_db.remove_full_db_if_present()  # must not raise

    assert not missing_path.exists()
