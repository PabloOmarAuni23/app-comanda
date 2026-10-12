"""Conexión a PostgreSQL con la misma interfaz mínima que usa app.py con sqlite3."""

ADVISORY_LOCK_KEY = 7001


class PostgresConnection:
    def __init__(self, url):
        import psycopg
        from psycopg.rows import dict_row

        self._connection = psycopg.connect(url, row_factory=dict_row, connect_timeout=10)

    def execute(self, sql, params=()):
        if sql.strip().upper() == "BEGIN IMMEDIATE":
            sql = f"SELECT pg_advisory_xact_lock({ADVISORY_LOCK_KEY})"
        return self._connection.execute(sql.replace("?", "%s"), params)

    def commit(self):
        self._connection.commit()

    def close(self):
        self._connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self._connection.commit()
        else:
            self._connection.rollback()
        return False