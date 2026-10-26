# India cities and towns

`cities-india.json` is derived from the India records in the [GeoNames cities500 extract](https://download.geonames.org/export/dump/), with state names from `admin1CodesASCII.txt`. Source data downloaded on 26 October 2026. GeoNames provides population-over-500 settlements and administrative seats; it is not a complete census of every Indian village or every newly notified town. Its coverage includes all 36 Indian states and Union Territories.

Attribution: **GeoNames**, [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The source is provided as-is without accuracy, timeliness or completeness warranties. Changes: India filtering, populated-place filtering, retained local names/aliases, normalized numeric fields and sorted rows. The application merges geographic duplicates and preserves original Funillion city IDs and curated neighbourhoods. Consequently the number of selectable locations differs from the number of source rows.

Refresh with:

```sh
python scripts/import-cities.py path/to/cities500.zip path/to/admin1CodesASCII.txt
```

Commit the resulting JSON so production starts without downloading data. City selection, event ingestion, signup, planners, map coordinates and clean SEO routes share the same directory. Same-name towns have distinct IDs; state hints disambiguate ingestion. Existing metro satellite cities such as Noida, Gurugram and Thane are independent locations for newly ingested listings. Existing stored events retain their original city IDs.

The crawler rotates `CRAWL_CITIES_PER_RUN` cities per background run and processes requested cities from a bounded demand queue. A selected city is eligible for another attempt after six hours. Source robots rules, site availability and provider coverage determine the real events found; a supported city can legitimately have no listings. Demo generation remains limited to the original 14 featured locations and is not expanded nationwide.
