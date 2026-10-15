-- TicketHub Schema for 200k concurrency

CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE seats (
  id VARCHAR(10) PRIMARY KEY, -- e.g., 'A-2', 'C-3'
  section CHAR(1) NOT NULL,
  row_num INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE' 
    CHECK (status IN ('AVAILABLE', 'HELD', 'SOLD')),
  version INT NOT NULL DEFAULT 1, -- for optimistic locking
  held_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE holds (
  id VARCHAR(36) PRIMARY KEY,
  seat_id VARCHAR(10) NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'CONFIRMED')),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(seat_id, status) -- only one active hold per seat (partial index would be better)
);

CREATE INDEX idx_holds_expires ON holds(expires_at);
CREATE INDEX idx_holds_user ON holds(user_id);

CREATE TABLE orders (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  seat_id VARCHAR(10) NOT NULL REFERENCES seats(id),
  hold_id VARCHAR(36) NOT NULL REFERENCES holds(id),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'CANCELLED')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(seat_id) -- prevents double-booking at DB level
);

-- Critical Atomic Operation to prevent double-booking (no locks)
-- UPDATE seats SET status='HELD', version=version+1, held_at=NOW() 
-- WHERE id=:seatId AND status='AVAILABLE' AND version=:expectedVersion;
-- App checks rowCount: if 1 = SUCCESS (201), if 0 = 409 Conflict