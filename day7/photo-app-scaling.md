# SnapShare Scaling Plan - Day 7 Assignment

## 1. Assumptions and Daily Active Users (DAU)
- Total registered users: 10,000,000
- % active each day: 10%
- DAU = 10M * 10% = **1,000,000 active users per day**
- Each active user: 1 upload/day and 50 feed views/day
- Avg photo: 2 MB, Thumbnail: 50 KB = 2.05 MB total per upload
- Estimation: 1 day ≈ 100,000 seconds (real is 86,400s)
- Photos are immutable, need high durability and low latency

## 2. Calculations

**Uploads per second:**
Average = 1,000,000 uploads / 100,000 sec = **10/sec**
Exact = 1,000,000 / 86,400 = 11.57/sec
Peak (5x) = 10 * 5 = **50/sec** (exact ~58/sec)

**Feed views per second:**
Total per day = 1M * 50 = 50,000,000 views/day
Average = 50M / 100,000 = **500/sec**
Exact = 50M / 86,400 = 578.7/sec
Peak (5x) = 500 * 5 = **2,500/sec** (exact ~2,893/sec)

**Photo storage per year:**
Per day = 1M * 2.05 MB = 2.05 TB/day
Per year = 2.05 TB * 365 = **748 TB/year (0.73 PB/year)**
If only originals: 2 MB * 1M = 2 TB/day = 730 TB/year

## 3. Read-Heavy or Write-Heavy?
**READ-HEAVY.** Ratio is 50 reads : 1 write.

What that means for design: We optimize for fast reads, not writes. We need Cache, Read Replica, and CDN to handle 500-2500 reads/sec. We can accept slow or async writes. We should not over-optimize DB for writes, we need to scale read path.

## 4. Why Photos Should NOT Be Stored Inside Database

Never store BLOBs in relational DB because:
1. DB becomes huge (748TB/year) - expensive, backups fail, replication lags.
2. DB is for structured queries, not serving large binaries.
3. Slows down all other queries.

Where they should go instead:
**Object Storage like Amazon S3 / GCS.** It is designed for files, cheap, 11 9's durability, infinite scale, and works perfectly with CDN. DB only stores metadata (photo_id, user_id, s3_url).

## 5. Architecture Diagram (Text)

                        [ Clients / Mobile App ]
                                 |
                                 v
                            [  CDN  ]  <-- caches /thumbnails and /originals
                                 |
                                 v
                          [ Load Balancer (ALB/Nginx) ]
                          /           |           \
            [ App Server 1 ]   [ App Server 2 ]   [ App Server 3 ]  <- Stateless
                    \             |             /
                     +-------------+-------------+
                     |             |             |
               [ Cache: Redis ] [ Message Queue ] |
                     |             |             |
                     |      [ Thumbnail Worker ] |
                     |             |             |
               [ Object Storage S3 ]             |
               - bucket/originals/               |
               - bucket/thumbnails/              |
                                   [ DB Primary (Postgres) - Writes ]
                                               |
                                   [ DB Read Replica - Reads ]

## 6. Each Component in One Sentence

- **CDN:** Serves static images/thumbnails from edge locations close to user to reduce latency and origin load.
- **Load Balancer:** Distributes incoming requests across healthy stateless app servers and enables zero-downtime scaling.
- **App Servers (Stateless):** Handles API logic without storing user session locally, so any server can serve any request.
- **Cache (Redis):** Stores hot feed pages and user timelines in memory for <10ms reads instead of hitting DB.
- **Database Primary:** Single source of truth for users, follows, photo metadata with strong consistency for writes.
- **Database Read Replica:** Handles heavy 500-2500/sec feed read queries to offload primary and scale reads.
- **Object Storage (S3):** Cheap, durable, scalable storage for 748TB/year of actual photo bytes.
- **Queue (SQS/RabbitMQ):** Decouples slow thumbnail work from fast upload request so user gets instant response.
- **Thumbnail Worker:** Async background process that creates 50KB thumbnails so feed scrolling is fast.

## 7. Upload Flow Step-by-Step Including Thumbnail Job

1. User selects photo, app POSTs to `api.snapshare.com/upload` -> goes through CDN -> Load Balancer.
2. LB picks a healthy, stateless App Server.
3. App Server validates auth and file (type, size).
4. App Server generates UUID `photoId`.
5. App Server uploads original 2MB directly to Object Storage `s3://snapshare/originals/{photoId}.jpg`.
6. App Server inserts row into DB Primary: `photos (id, user_id, original_url, status='PROCESSING')`.
7. App Server pushes message `{photoId, s3Key}` into Queue.
8. App Server invalidates/deletes followers feed cache in Redis and returns HTTP 201 to user immediately.
9. Thumbnail Worker long-polls Queue, gets job.
10. Worker downloads original from S3, resizes to 200x200 50KB thumbnail using sharp/imagemagick.
11. Worker uploads thumbnail to `s3://snapshare/thumbnails/{photoId}.jpg`.
12. Worker updates DB Primary `thumbnail_url`, `status='READY'`.
13. Worker ACKs and deletes job from Queue.
14. Next feed request: App checks Cache miss -> queries Read Replica -> gets S3 thumbnail URLs -> populates Cache -> returns via CDN.

## 8. Trade-offs

**1. Eventual Consistency vs Strong Consistency (Cache + Replica lag):**
We use cache and read replica to serve 2500 reads/sec fast, but a user might see stale feed for 1-2 seconds after friend uploads. If we forced strong consistency (always read from primary with no cache), feed would be instantly accurate but slow and DB would crash at peak. We choose performance over instant consistency.

**2. Pre-compute Thumbnails vs On-the-fly Resizing:**
Pre-computing costs extra storage (50KB extra per photo) and worker compute, but makes feed scroll super fast (50KB vs 2MB = 40x less data). On-the-fly would save storage but every scroll would be CPU heavy and slow (bad for read-heavy 50:1). For SnapShare, pre-compute is better.

**3. S3 + CDN vs Local Disk:**
S3 is ~100ms slower than local SSD but infinitely scalable and 10x cheaper at PB scale. CDN hides that latency after first hit, so cost and durability win over small latency penalty.

**4. Push vs Pull for Feed:**
We chose pull model (cache + DB query on feed view) which is simple for 10M users. Push model (fanout to all followers inboxes on upload) would make feed view O(1) super fast but expensive for celebrity users (1 upload -> 1M writes). At current scale pull is cheaper.