// scripts/fetch-station-coordinates.ts
import { writeFileSync } from "node:fs";
import { projectVersion } from "@/config";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

const OVERPASS_QUERY = `
[out:csv(::id, "name", "railway:ref", "ref", ::lat, ::lon; true; ",")]
[timeout:60];

node["railway"~"^(station|halt)$"]
  ["station"!~"^(subway|light_rail|monorail)$"]
  ["subway"!="yes"]
  ["light_rail"!="yes"]
  ["monorail"!="yes"]
  ["highspeed"!="yes"]
  ["operator"!~"MRT|LRT|KCIC|Kereta Cepat|Angkasa Pura", i]
  ["network"!~"MRT|LRT|KCIC|Whoosh|Bandara", i]
  ["disused"!="yes"]
  ["abandoned"!="yes"]
  ["name"!~"^(Gambir|Jakarta Gudang|Cigading|Bogor Paledang|Bandara Soekarno-Hatta)$"]
  (-6.61, 105.95, -5.90, 107.17);

out body;
`;

// Known ticketing code overrides (OSM -> KAI official)
const CODE_OVERRIDES: Record<string, string> = {
	PCN: "POC", // Pondok Cina
	TTI: "THI", // Tanah Tinggi
	TOJ: "TOJB", // Tonjong Baru
};

// Fallbacks for stations missing codes in OSM
const NAME_OVERRIDES: Record<string, string> = {
	"Batu Ceper": "BPR",
	Jatake: "JTK",
};

async function main() {
	console.log("Fetching station coordinates from Overpass API...");

	const response = await fetch(OVERPASS_ENDPOINT, {
		method: "POST",
		headers: {
			"User-Agent": `KRL-Schedule-DB/${projectVersion}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
	});

	if (!response.ok) {
		throw new Error(
			`Overpass API error: ${response.status} ${response.statusText}`,
		);
	}

	const csvText = await response.text();
	const lines = csvText.trim().split("\n");
	const rows = lines.slice(1); // skip header

	const output: string[] = ["sta_id,sta_name,lat,lon"];

	for (const row of rows) {
		const parts = row.split(",");
		if (parts.length < 6) continue;

		const [, name, railwayRef, ref, lat, lon] = parts;

		// Resolve station code
		let code = railwayRef || ref || NAME_OVERRIDES[name] || "";
		if (CODE_OVERRIDES[code]) {
			code = CODE_OVERRIDES[code];
		}

		output.push(`${code},${name.toUpperCase()},${lat},${lon}`);
	}

	writeFileSync("data/station_coordinates.csv", output.join("\n"));
	console.log(
		`Successfully wrote ${output.length - 1} stations to data/station_coordinates.csv`,
	);
}

main().catch(console.error);
