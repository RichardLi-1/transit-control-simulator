# TTC Train Traffic Control Simulator

A Toronto Subway Line 1 (Yonge-University) board. Python sim is the source of truth. React + canvas is the glass.

Deployed at: https://transitcontrol.richardli.dev/

Distances are real (38.4 km Vaughan MC → Finch). Trains run CBTC moving block: the zone controller gives each train an end of authority, ATO drives a jerk-limited speed profile under it, and ATP brakes if it would be overrun. Every train stops at every platform in both directions and turns back at Finch and Vaughan MC. Signals exist only at interlockings. Service follows the time of day, with trains entering and leaving through Wilson and Davisville yards. Speeds, dwells and yard positions are approximations, not TTC data.

Click a train to inspect it, then hold, express or skip it from the **Train** tab of the right-hand inspector. **Dispatch** switches live Rule vs PPO and can run an offline A/B (same seed). **Events** logs incidents and injects new ones. Schematic / Map, safe zones, labels and high contrast are in the top bar; the legend is in the status bar. **GUIDE** answers “where is run 4?” and points at the UI. SIM time starts at 06:00, not your laptop clock.

## Run

```bash
npm run setup    # backend venv, frontend deps, ml venv
npm run dev      # sim :8000, ML :8001, UI :5173
```

Open http://localhost:5173. Frontend-only (`cd frontend && npm run dev`) falls back to mock if the sim is down; `?mock=1` forces it.

Bundled PPO: `ml/models/deployed/ppo_baseline/policy.zip`.

## Layout

- `backend/` sim, ATO/ATP, commands, `/state`
- `frontend/` map, GUIDE, dispatch panel
- `ml/` training API and live policy
- `docs/PROJECT.md` longer design notes

Vite proxies `/topology` `/state` `/commands` `/events` `/ops` `/sim` `/health` to :8000 and `/ml` to :8001.

```bash
npm run build:frontend
docker compose up --build    # UI :8080
```

## License
MIT