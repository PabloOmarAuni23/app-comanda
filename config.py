"""Configuración centralizada de la aplicación."""

import os
from pathlib import Path

# Puerto y entorno
PORT = int(os.environ.get("PORT", "8000"))
ENV = os.environ.get("FLASK_ENV", "production")

# Base de datos
DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL:
    # PostgreSQL configurado
    SQLALCHEMY_DATABASE_URI = DATABASE_URL
else:
    # SQLite local
    SQLALCHEMY_DATABASE_URI = f"sqlite:///{Path(__file__).parent / 'instance' / 'comanda.sqlite3'}"

# Ruta de la base de datos (para SQLite)
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", "instance/comanda.sqlite3"))

# Elasticache / Redis (opcional)
REDIS_URL = os.environ.get("REDIS_URL")

# Tiempo de inactividad
SESSION_LIFETIME = int(os.environ.get("SESSION_LIFETIME", "3600"))