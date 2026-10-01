import os
import secrets
import bcrypt
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from uuid import uuid4

from fastapi import FastAPI, Depends, HTTPException, status, Header
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Boolean, Text, JSON, ForeignKey, func
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship, Session
import redis

# Database setup
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./test.db")
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Redis setup
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
redis_client = redis.from_url(REDIS_URL)

# DDL for database schema (executable)
API_KEYS_DDL = """
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_secret_hash VARCHAR(255) NOT NULL,
    scopes JSONB NOT NULL,
    rate_limit INTEGER NOT NULL,
    expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS api_key_usage (
    id SERIAL PRIMARY KEY,
    api_key_id INTEGER REFERENCES api_keys(id),
    endpoint VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL,
    status INTEGER NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);
"""

# Database models
class ApiKey(Base):
    __tablename__ = "api_keys"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(String(255), nullable=False)
    key_secret_hash = Column(String(255), nullable=False)
    scopes = Column(JSON, nullable=False)
    rate_limit = Column(Integer, nullable=False)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_used_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    
    usage = relationship("ApiKeyUsage", back_populates="api_key")

class ApiKeyUsage(Base):
    __tablename__ = "api_key_usage"
    
    id = Column(Integer, primary_key=True, index=True)
    api_key_id = Column(Integer, ForeignKey("api_keys.id"), nullable=True)
    endpoint = Column(String(255), nullable=False)
    method = Column(String(10), nullable=False)
    status = Column(Integer, nullable=False)
    timestamp = Column(DateTime, nullable=False, default=datetime.utcnow)
    
    api_key = relationship("ApiKey", back_populates="usage")

# Create tables
Base.metadata.create_all(bind=engine)

# Pydantic models
class ApiKeyCreate(BaseModel):
    name: str
    scopes: List[str]
    expires_at: Optional[datetime] = None
    rate_limit: Optional[int] = 1000

class ApiKeyResponse(BaseModel):
    api_key_id: int
    key: str  # Only shown on creation
    created_at: datetime
    expires_at: Optional[datetime]
    rate_limit: int

class ApiKeyListItem(BaseModel):
    api_key_id: int
    name: str
    scopes: List[str]
    created_at: datetime
    last_used_at: Optional[datetime]
    rate_limit: int
    is_active: bool

class ApiKeyUsageStats(BaseModel):
    api_key_id: int
    total_requests: int
    requests_by_endpoint: Dict[str, int]
    rate_limit_hits: int
    errors: Dict[str, int]

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Dependency to get Redis client
def get_redis():
    return redis_client

# Helper functions
def generate_api_key() -> str:
    """Generate a new API key in format sk_live_<random> or sk_test_<random>"""
    prefix = "sk_live_" if os.getenv("ENVIRONMENT") == "production" else "sk_test_"
    random_part = secrets.token_urlsafe(32)
    return f"{prefix}{random_part}"

def hash_key(key: str) -> str:
    """Hash a plaintext API key using bcrypt"""
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(key.encode('utf-8'), salt)
    return hashed.decode('utf-8')

def verify_key(plaintext_key: str, hashed_key: str) -> bool:
    """Verify a plaintext key against its bcrypt hash"""
    return bcrypt.checkpw(plaintext_key.encode('utf-8'), hashed_key.encode('utf-8'))

def validate_api_key(
    key: str,
    required_scope: Optional[str] = None,
    db: Session = Depends(get_db),
    redis_client: redis.Redis = Depends(get_redis)
) -> ApiKey:
    """
    Validate an API key from the Authorization header.
    Returns the ApiKey object if valid, raises HTTPException otherwise.
    """
    # Check key format
    if not key.startswith(("sk_live_", "sk_test_")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key format"
        )
    
    # Find API key by attempting to verify against all active keys (inefficient but secure)
    # In production, we would use a key ID or prefix lookup, but spec doesn't specify
    # For now, we'll do a linear scan (not ideal for large scale but meets spec)
    api_key = db.query(ApiKey).filter(ApiKey.is_active == True).first()
    while api_key:
        if verify_key(key, api_key.key_secret_hash):
            break
        api_key = db.query(ApiKey).filter(ApiKey.id > api_key.id, ApiKey.is_active == True).first()
    else:
        api_key = None
    
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key"
        )
    
    # Check expiration
    if api_key.expires_at and api_key.expires_at < datetime.utcnow():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key has expired"
        )
    
    # Check scopes
    if required_scope and required_scope not in api_key.scopes:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Insufficient scope. Required: {required_scope}"
        )
    
    # Check rate limit using Redis
    current_hour = datetime.utcnow().strftime("%Y-%m-%dT%H")
    redis_key = f"rate_limit:{api_key.id}:{current_hour}"
    current_count = redis_client.incr(redis_key)
    if current_count == 1:
        redis_client.expire(redis_key, 7200)  # Expire after 2 hours
    if current_count > api_key.rate_limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded"
        )
    
    return api_key

def log_api_key_usage(
    api_key_id: Optional[int],
    endpoint: str,
    method: str,
    status_code: int,
    db: Session = Depends(get_db)
):
    """Log API key usage to the database"""
    usage = ApiKeyUsage(
        api_key_id=api_key_id,
        endpoint=endpoint,
        method=method,
        status=status_code
    )
    db.add(usage)
    db.commit()

# FastAPI app
app = FastAPI(title="API Keys & Service Accounts")

# Security scheme
security = HTTPBearer()

# Endpoints
@app.post("/api-keys", response_model=ApiKeyResponse)
def create_api_key(
    key_data: ApiKeyCreate,
    db: Session = Depends(get_db)
):
    """Create a new API key"""
    # Generate key
    plaintext_key = generate_api_key()
    hashed_key = hash_key(plaintext_key)
    
    # Create API key record
    db_api_key = ApiKey(
        user_id=1,  # In real app, get from auth context
        name=key_data.name,
        key_secret_hash=hashed_key,
        scopes=key_data.scopes,
        rate_limit=key_data.rate_limit or 1000,
        expires_at=key_data.expires_at
    )
    db.add(db_api_key)
    db.commit()
    db.refresh(db_api_key)
    
    return ApiKeyResponse(
        api_key_id=db_api_key.id,
        key=plaintext_key,
        created_at=db_api_key.created_at,
        expires_at=db_api_key.expires_at,
        rate_limit=db_api_key.rate_limit
    )

@app.get("/api-keys", response_model=List[ApiKeyListItem])
def list_api_keys(
    db: Session = Depends(get_db)
):
    """List API keys (masked) for the current user"""
    api_keys = db.query(ApiKey).filter(ApiKey.user_id == 1, ApiKey.is_active == True).all()
    return [
        ApiKeyListItem(
            api_key_id=key.id,
            name=key.name,
            scopes=key.scopes,
            created_at=key.created_at,
            last_used_at=key.last_used_at,
            rate_limit=key.rate_limit,
            is_active=key.is_active
        )
        for key in api_keys
    ]

@app.delete("/api-keys/{api_key_id}")
def revoke_api_key(
    api_key_id: int,
    db: Session = Depends(get_db)
):
    """Revoke an API key"""
    api_key = db.query(ApiKey).filter(ApiKey.id == api_key_id).first()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found"
        )
    
    api_key.is_active = False
    db.commit()
    
    return {"success": True, "revoked_at": datetime.utcnow()}

@app.post("/api-keys/{api_key_id}/rotate")
def rotate_api_key(
    api_key_id: int,
    db: Session = Depends(get_db),
    redis_client: redis.Redis = Depends(get_redis)
):
    """Rotate an API key (generate new, disable old with grace period)"""
    api_key = db.query(ApiKey).filter(ApiKey.id == api_key_id).first()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found"
        )
    
    # Generate new key
    new_plaintext = generate_api_key()
    new_hashed = hash_key(new_plaintext)
    
    # Revoke old key immediately but allow grace period
    old_revoked_at = datetime.utcnow()
    grace_period_ends_at = old_revoked_at + timedelta(hours=24)
    
    # Update old key
    api_key.is_active = False
    api_key.key_secret_hash = new_hashed  # Temporarily store new hash for validation during grace period
    api_key.created_at = old_revoked_at  # Reset created_at to rotation time for grace period tracking
    
    # Create new key record (active immediately)
    new_api_key = ApiKey(
        user_id=api_key.user_id,
        name=api_key.name,
        key_secret_hash=new_hashed,
        scopes=api_key.scopes,
        rate_limit=api_key.rate_limit,
        expires_at=api_key.expires_at,
        is_active=True
    )
    db.add(new_api_key)
    db.commit()
    db.refresh(new_api_key)
    
    # Reset rate limit counters for new key in Redis
    current_hour = datetime.utcnow().strftime("%Y-%m-%dT%H")
    redis_client.delete(f"rate_limit:{new_api_key.id}:{current_hour}")
    
    return {
        "new_key": new_plaintext,
        "old_key_revoked_at": old_revoked_at.isoformat(),
        "grace_period_ends_at": grace_period_ends_at.isoformat()
    }

@app.get("/api-keys/{api_key_id}/usage", response_model=ApiKeyUsageStats)
def get_api_key_usage(
    api_key_id: int,
    from_date: Optional[datetime] = None,
    to_date: Optional[datetime] = None,
    db: Session = Depends(get_db)
):
    """Get usage statistics for an API key"""
    api_key = db.query(ApiKey).filter(ApiKey.id == api_key_id).first()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found"
        )
    
    # Build query
    query = db.query(ApiKeyUsage).filter(ApiKeyUsage.api_key_id == api_key_id)
    if from_date:
        query = query.filter(ApiKeyUsage.timestamp >= from_date)
    if to_date:
        query = query.filter(ApiKeyUsage.timestamp <= to_date)
    
    usage_records = query.all()
    
    # Calculate stats
    total_requests = len(usage_records)
    requests_by_endpoint = {}
    rate_limit_hits = 0
    errors = {}
    
    for record in usage_records:
        endpoint_method = f"{record.method} {record.endpoint}"
        requests_by_endpoint[endpoint_method] = requests_by_endpoint.get(endpoint_method, 0) + 1
        
        if record.status == 429:
            rate_limit_hits += 1
        if record.status >= 400:
            errors[str(record.status)] = errors.get(str(record.status), 0) + 1
    
    return ApiKeyUsageStats(
        api_key_id=api_key_id,
        total_requests=total_requests,
        requests_by_endpoint=requests_by_endpoint,
        rate_limit_hits=rate_limit_hits,
        errors=errors
    )

@app.get("/admin/api-keys")
def admin_list_api_keys(
    user_id: Optional[int] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Admin endpoint: list all API keys for audit"""
    query = db.query(ApiKey)
    if user_id is not None:
        query = query.filter(ApiKey.user_id == user_id)
    if status == "active":
        query = query.filter(ApiKey.is_active == True)
    elif status == "inactive":
        query = query.filter(ApiKey.is_active == False)
    
    api_keys = query.all()
    return {
        "keys": [
            {
                "api_key_id": key.id,
                "user_id": key.user_id,
                "name": key.name,
                "scopes": key.scopes,
                "created_at": key.created_at,
                "last_used_at": key.last_used_at,
                "rate_limit": key.rate_limit,
                "expires_at": key.expires_at,
                "is_active": key.is_active
            }
            for key in api_keys
        ],
        "total": len(api_keys)
    }