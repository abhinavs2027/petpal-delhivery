# PetPal × Delhivery mock server

One Vercel deployment = one MCP connector for AgenticOrg: `https://YOUR-APP.vercel.app/mcp`

## Capabilities (17 tools)

### Existing Delhivery capabilities (Round 2, capabilities 21–27)
| Round 2 capability | MCP tool | Delhivery endpoint |
|---|---|---|
| 21 check_serviceability | delhivery_pincode_serviceability | GET /c/api/pin-codes/json/ |
| 22 create_reorder_shipment | delhivery_create_shipment (+ delhivery_create_warehouse) | POST /api/cmu/create.json (+ POST /api/backend/clientwarehouse/create/) |
| 23 track_delivery | delhivery_track_shipment | GET /api/v1/packages/json/ |
| 24 handle_missed_delivery | delhivery_ndr_action, delhivery_ndr_status | POST /api/p/update, GET /api/cmu/get_bulk_upl/{id} |
| 25 initiate_return_pickup (QC) | delhivery_create_shipment(_on_behalf) with payment_mode "Pickup" + qc | POST /api/cmu/create.json |
| 26 resolve_and_verify_address | validate_address, verify_address, geocode_address | Delhivery Maps (tool names as in the Delhivery Maps MCP) |
| 27 get_route_and_eta | route, compute_distance_matrix | Delhivery Maps |
| helpers | delhivery_expected_tat, delhivery_edit_or_cancel_shipment | GET /api/dc/expected_tat, POST /api/p/edit |

### Imagined capabilities (Round 2 must-builds 28–30), flagged `imagined_capability: true`
| # | MCP tool | Endpoint | Data Delhivery already holds |
|---|---|---|---|
| 28 emergency_same_day_run | delhivery_direct_rush_delivery, delhivery_direct_status | POST /api/direct/v1/orders, GET /api/direct/v1/orders/{id} | Delhivery Direct's live rider fleet and city coverage (today usable only in its consumer app) |
| 29 predict_days_of_food_left | delhivery_replenishment_forecast | GET /api/v1/replenishment/forecast | Date and product description of every repeat delivery to the same consignee: enough to compute a refill cycle |
| 30 reorder_without_own_warehouse | delhivery_create_shipment_on_behalf | POST /api/cmu/create_on_behalf.json | Every seller's client account and registered warehouses: enough for a seller to grant an agent consent to ship from its warehouse |

## Deploy on Vercel
1. Upload this folder's contents to a new GitHub repo (`api/`, `lib/` folders and all files at the top level).
2. Vercel → Add New → Project → Import the repo → Deploy.
3. Storage → Create Database → Upstash for Redis (Free) → connect to this project.
4. Settings → Environment Variables (tick Production):
   - `PUBLIC_BASE_URL` = `https://YOUR-APP.vercel.app` (no `/` at the end)
   - `DELHIVERY_TOKEN` = `petpal-demo-token`
   - `CONTROL_KEY` = `curtain`
5. Deployments → ⋯ → Redeploy.
6. Open `https://YOUR-APP.vercel.app/` → must show `"storage":"upstash-redis"` and `"public_base_url_set":true`.

## Register on AgenticOrg
Connectors → Add Connector → Name `delhivery_petpal_mock` → tick **MCP** → MCP Server URL `https://YOUR-APP.vercel.app/mcp` → Category `ops` → Auth Type `none` → Register. It should discover **17 tools**.

## Behind the curtain (open these in a browser)
- Live call log for the recording: `/mock/console?key=curtain`
- Reset before each run: `/mock/reset?key=curtain&clear_log=true`
- Change the world: `/mock/set?key=curtain&<setting>=<value>`

| Situation | Open this before the run |
|---|---|
| Happy path | `/mock/reset?key=curtain&clear_log=true` |
| Failed delivery (NDR) | `/mock/set?key=curtain&delivery=ndr` |
| Delivery delayed past run-out | `/mock/set?key=curtain&delivery=delayed` |
| Address not serviceable | owner gives pincode 744301 |
| Incomplete / wrong address | `/mock/set?key=curtain&address_quality=incomplete` |
| No rider for rush delivery | `/mock/set?key=curtain&direct_riders=none` (NCR pincodes; Lucknow is outside Direct's cities) |
| Timeout (25 s then 504) | `/mock/set?key=curtain&timeout_next=create_shipment_on_behalf` |
| Malformed reply | `/mock/set?key=curtain&malformed_next=track_shipment` |
| Server error 500 | `/mock/set?key=curtain&error_next=pincode_serviceability` |

`timeout_next`, `malformed_next` and `error_next` fire once, on the next call to that operation, so a retry succeeds. Operation names: pincode_serviceability, expected_tat, create_warehouse, create_shipment, create_shipment_on_behalf, edit_or_cancel_shipment, track_shipment, ndr_action, ndr_status, validate_address, verify_address, geocode_address, route, compute_distance_matrix, direct_rush_delivery, direct_status, replenishment_forecast.

## Day-one data
Owner: House 12, Vipul Khand, Gomti Nagar, Lucknow 226010, phone 9999999999 · Store: `HAPPYPAWS_LKO`, warehouse `HAPPYPAWS_GOMTINAGAR`, consent `CONSENT-BUDDY-001` · Delivery history: two earlier deliveries of "Renal dry food 2kg", 26 days apart, the last 22 days ago, so the forecast says about 4 days of food left.

## Caveats for the write-up
- B2C endpoint paths and fields follow Delhivery's developer docs. The expected-TAT and NDR-status response shapes were modelled from the docs as read in Round 2; re-check them.
- The Maps tools use the **tool names** from the Delhivery Maps MCP docs (delhivery.com/maps/developer). Their REST paths here (`/maps/v1/...`) are this server's own, and responses are simplified.
- Tracking advances one step per poll so a demo fits in five minutes.
