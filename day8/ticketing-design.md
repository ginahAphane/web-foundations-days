# TicketHub - System Design

## 1. Requirements

### Functional Requirements
- Users can browse events, search by date/venue/artist
- Users can view venue seat map and seat availability (Available, Held, Sold)
- Users can hold seats for 10 minutes (temporary reservation)
- Users can pay for held seats and get tickets (QR code)
- Users can view their order history / tickets
- Admin can create events and define seat inventory
- System must prevent double-booking of same seat

### Non-Functional Requirements
- **Correctness:** Zero double-bookings. Atomic seat reservation is critical.
- **Speed:** Browse p95 < 300ms, View seat map p95 < 500ms, Hold p95 < 800ms even under peak
- **Scalability:** Survive "big sale" - 200,000 people trying to buy 20,000 seats in 10 minutes
- **Availability:** 99.9% during sale
- **Fairness:** FIFO queue during overload, rate limiting per user

## 2. Estimates

### Normal Traffic
- 2M registered users, 50,000 DAU, each viewing 10 pages = 500,000 page views/day
- QPS: Browse 500 req/s, Seat Map 200 req/s, Hold 10 req/s, Payment 5 req/s (5,000 tickets sold/day)
- Storage: 100k events/year * 5000 seats avg = 500M seat rows archived

### Big Sale Peak
- 200,000 people try to buy 20,000 seats in first 10 minutes (600 seconds)
- QPS spike: 200,000 / 600 = 333 hold attempts per second for same event
- Seat Map: 20,000 req/s (100x), Hold: 5,000 req/s (500x), Payment: 500 req/s (100x)
- Comparison: Normal = read-light, write-rare. Big Sale = read-heavy + contention-heavy. Need cache + queue.

We design for peak, scale down for normal.

## 3. API Design

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | /api/events?search=&date=&venue= | Browse events |
| GET | /api/events/{eventId} | Event details |
| GET | /api/events/{eventId}/seats | View seat map |
| POST | /api/events/{eventId}/holds | Hold seats |
| POST | /api/orders | Pay for held seats |
| GET | /api/users/me/orders | View my tickets |
| DELETE | /api/holds/{holdId} | Release hold |

Example:
POST /api/events/123/holds {"seatIds":["A-12","A-13"]}
201 Created: {"holdId":"h_abc","expiresAt":"2026-10-21T10:10:00Z"}

Status: 200 OK, 201 Created, 404 Not Found, 409 Conflict (seat taken), 429 Too Many Requests, 410 Gone

## 4. Data Model

**users**: id PK UUID, email UNIQUE, name, created_at
**events**: id PK, name, artist, venue_id, start_time, total_seats, status
**seats**: id PK, event_id FK, label (A-12), section, status ENUM (AVAILABLE,HELD,SOLD), hold_id FK nullable, version INT, UNIQUE(event_id,label)
**holds**: id PK UUID, user_id FK, event_id FK, expires_at, status (ACTIVE,EXPIRED,CONVERTED)
**hold_seats**: hold_id FK, seat_id FK, PK(hold_id,seat_id)
**orders**: id PK UUID, user_id FK, event_id FK, hold_id FK UNIQUE, total_amount, status, payment_ref, created_at

Relationships: events 1--* seats, users 1--* holds, users 1--* orders, holds 1--* hold_seats, holds 1--1 orders

## 5. Preventing Double-Booking

Cache and CDN only SHOW availability. They DO NOT guarantee safety because they are stale and 2 app servers can read AVAILABLE at same time.

We use atomic conditional transaction in Postgres:

BEGIN;
SELECT * FROM seats WHERE id IN (:seatIds) AND event_id=:eventId FOR UPDATE;
-- if any status!= AVAILABLE, ROLLBACK 409
UPDATE seats SET status='HELD', hold_id=:holdId, version=version+1 WHERE id IN (:seatIds) AND status='AVAILABLE';
-- check rowCount == requested, else ROLLBACK
COMMIT;

If 2 users try same seat, DB serializes. First UPDATE affects 1 row, second affects 0 rows. We return 409 Conflict. This guarantees zero double-booking.

## 6. Architecture

Components:
1. CDN (Cloudflare): static + cached GET /events - offloads 80% reads
2. Load Balancer (ALB): distributes to 4-50 app servers (horizontal scaling)
3. API Gateway + Rate Limiter (Redis): 10 req/s per IP for holds, virtual queue token
4. App Servers: stateless Node.js, auto-scaled
5. Redis Cache: seat map cache 5s TTL + SETNX lock as pre-check
6. Postgres Primary + Read Replicas: source of truth for atomic TX
7. Queue (BullMQ): order processing
8. Payment Gateway (Stripe): idempotent via holdId

Big Sale Flow: User -> CDN -> LB -> Rate Limiter (queue if overloaded) -> App Server -> Check Redis -> Try atomic DB hold -> Return holdId -> Pay in 10 min. If DB overloaded, keep users in queue (backpressure).

## 7. Trade-offs

1. Strong Consistency vs Availability: We choose CP for holds to prevent double-booking, even if slower, vs AP which would risk overselling.
2. Hold Expiry 10 min vs UX: Short 2 min frees inventory fast but frustrates payment; long 30 min good UX but blocks seats. 10 min middle ground.
3. Pre-computed Seats Table vs Dynamic: Pre-create 20k rows per event uses more storage but gives O(1) atomic updates. Trade storage for correctness.