# Connect Spoolman

Print Partner can read filament and spool inventory from a Spoolman server. Builds can use that inventory for role colors and per-part spool assignments. Confirmed printer jobs can deduct estimated material when the host reports filament usage.

## Requirements

- A running Spoolman server reachable from the Print Partner container
- The Spoolman base URL, usually `http://<host>:7912`
- An API key if your Spoolman deployment requires one

## Add the integration

1. Open **Settings**.
2. Find **Optional integrations** under the Library settings.
3. Select **Add Spoolman**.
4. Enter a name, base URL, and optional API key.
5. Save and test the connection.

Use the URL that the Print Partner container can reach. `localhost` inside the container refers to the container itself, not the Docker host.

## Docker networking

If Spoolman runs in the same Compose project, address it by service name:

```text
http://spoolman:7912
```

If it runs on another LAN computer, use that computer's address:

```text
http://192.168.1.50:7912
```

Docker Desktop also provides `host.docker.internal` for services running directly on the host:

```text
http://host.docker.internal:7912
```

On Linux, a LAN address or shared Docker network is usually clearer than host gateway aliases.

## Choose filament for a Build

Open a Build and go to **Sources**. Assign a filament color or Spoolman filament to each role. You may also choose a specific spool when the Build must use inventory from one location.

The Plan and Checkoff screens show the available weight reported by Spoolman. Print Partner does not treat this value as a reservation.

Per-part overrides can select a different spool from the role default. Clearing an override returns the part to the role setting.

## Material deductions

Print Partner can deduct material after a linked printer job reaches Checkoff and the user confirms the completed units.

The deduction requires:

- a Spoolman spool assignment for the affected part
- a printer adapter that reports filament usage
- a completed host job linked to the Checkoff units
- user confirmation in Checkoff

Moonraker reports `print_stats.filament_used`. PrusaLink reports its consumed material value when available. Print Partner converts the reported length to weight using filament properties and sends the usage to Spoolman.

If Spoolman is unavailable or the required mapping is missing, Checkoff still completes and reports the deduction problem separately.

## Security

Store the Spoolman API key in the integration secret field. Print Partner redacts integration secrets from normal API responses and logs.

Keep unauthenticated Spoolman servers on a trusted network. Use HTTPS when traffic crosses an untrusted network.

## Troubleshooting

### Connection refused

Test the URL from the Print Partner host or container. Confirm that a firewall or Docker network is not blocking port 7912.

### Filaments do not appear

Confirm the integration test succeeds, then reload Sources. Check that Spoolman contains filament records and that the selected integration remains enabled.

### Weight is missing

A filament may exist without an active spool. Select a specific spool or add inventory in Spoolman.

### Usage was not deducted

Confirm the part has a specific Spoolman spool, the printer job is linked to the Checkoff units, and the printer adapter reported material use. Review server logs for a failed Spoolman request.

## Related documentation

- [Printer setup](PRINTER_SETUP.md)
- [Architecture](../ARCHITECTURE.md)
- [Operations](../../OPERATIONS.md)
