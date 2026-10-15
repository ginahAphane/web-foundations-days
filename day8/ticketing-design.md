# TicketHub - 200k User Ticket Sale - System Design

**Live Demo:** https://ginahAphane.github.io/web-foundations-days/day8/
**Problem:** 200,000 users competing for 20,000 seats at same time. Prevent double-booking at scale.

## 1. Architecture and Scaling (25 points)

**Every component justified by a problem:**

- **CDN (Cloudflare):** Problem - 200k users loading seats page crashes origin. Solution - Cache static HTML/JS at edge, reduces origin load by 90%.
- **API Gateway + Load Balancer:** Problem - Single server dies at 200k RPS. Solution - Horizontal scaling to 10 nodes behind ALB, 20k RPS per node.
- **Redis Cache:** Problem - DB query for 20k seats on every refresh kills DB. Solution - Cache seat availability in Redis with 2s TTL, serve 95% reads from cache.
- **PostgreSQL (Primary):** Problem - Concurrent writes cause double-booking. Solution - Atomic conditional update is source of truth.
- **Queue (SQS) for Payment:** Problem - Payment API slow, holds expire. Solution - Async payment processing, holds extended via queue.

**Estimates:**
- 200,000 RPS peak, 20,000 seats = average 10 contenders per seat
- 200k * 500 bytes = 100MB/s ingress
- DB writes: 20k successful holds, ~180k failed with 409 (cheap)
- Cache hit ratio 95% = 10k DB reads/sec instead of 200k

**Trade-off Explained:**
Chose **Optimistic Locking (UPDATE ... WHERE status='AVAILABLE' + rowCount check)** over **Pessimistic Locking (SELECT FOR UPDATE)**.
Pessimistic would lock the row for entire transaction, creating a bottleneck queue of 200k transactions waiting, leading to timeouts and deadlocks.
Optimistic allows all 200k to attempt concurrently, DB executes atomically, only one wins (rowCount=1), others get rowCount=0 -> 409 Conflict. Higher throughput, lower latency, no lock contention. Retry cost is acceptable because failure is graceful.

## 2. API Design (20 points) - RESTful

### POST /api/hold
Hold a seat for 5 minutes.
- Request: `{ "seatId": "C-3", "userId": "u_123" }`
- Success: 201 Created `{ "holdId": "h_abc", "expiresAt": "2026-10-14T17:43:00Z" }`
- Error: 409 Conflict `{ "error": "Seat already held" }` - when rowCount=0
- Error: 404 Not Found - seat doesn't exist

### POST /api/confirm
Confirm payment for held seat.
- Request: `{ "holdId": "h_abc", "paymentToken": "tok_123" }`
- Success: 201 Created `{ "orderId": "o_123", "ticket": "C-3" }`
- Error: 410 Gone - hold expired
- Error: 409 Conflict - seat sold by another transaction

### GET /api/seats
List availability (cached in Redis).
- Success: 200 OK `{ "seats": [{"id":"A-2","status":"AVAILABLE"}, ...], "total": 20000, "available": 18500 }`

### GET /api/my-tickets
User's tickets.
- Success: 200 OK `{ "tickets": [...] }`
- Error: 401 Unauthorized

### DELETE /api/hold/:id
Release hold early.
- Success: 204 No Content
- Error: 404 Not Found

## 3. Data Model (20 points)

See schema.sql for full DDL with keys, types, constraints.

- seats: PK, CHECK status, version for optimistic locking
- holds: PK, FK to seats, FK to users, expires_at with index, CHECK
- orders: PK, FK, unique seat per order, status CHECK

## 4. Working Demo (20 points)

Live at /day8/ - Simulates 200k race attack, shows rowCount=1 SUCCESS vs rowCount=0 409 PROTECTED, graceful error handling without crash.