# Reflection

The most difficult concept in the course for me was understanding why cache does not prevent double-booking. At first I thought if we cache the seat map and update it quickly, two users cannot get the same seat. I learned through the transaction labs that cache is stale by design and two app servers can read AVAILABLE at the same time. What helped me overcome it was rewriting the UPDATE... WHERE status='AVAILABLE' example and testing with two terminals. Seeing one transaction return 0 rows made atomic conditional writes click - the database must be the single source of truth.

Based on feedback I received on my earlier URL shortener draft, where I was told my estimates were vague and my API had only three endpoints, I improved this capstone by doing real numbers. I estimated normal vs big sale QPS using the given facts - 50,000 DAU * 10 pages vs 200,000 people trying to buy 20,000 seats in 10 minutes (333 req/s contention) - and compared them, and I added seven endpoints with status codes and example bodies.

What will I learn next? Distributed locking with Redis Redlock, load testing the big sale with k6 at 200k concurrent users, and building idempotent checkout APIs. I also want to add monitoring metrics for queue depth and hold expiry during peak.

(Word count: 212)