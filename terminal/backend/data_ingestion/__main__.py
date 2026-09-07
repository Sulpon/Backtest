"""Convenience alias so `python -m data_ingestion` also works, in addition
to the primary `python -m data_ingestion.download` form."""
import sys

from .download import main

if __name__ == "__main__":
    sys.exit(main())
