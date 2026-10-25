from __future__ import annotations

import unittest
from importlib.metadata import PackageNotFoundError
from unittest.mock import patch

import sketchforge3d


class PackageVersionTest(unittest.TestCase):
    def test_version_uses_installed_distribution_metadata(self) -> None:
        with patch.object(sketchforge3d, "_distribution_version", return_value="1.28.0"):
            self.assertEqual(sketchforge3d._read_version(), "1.28.0")

    def test_version_falls_back_when_distribution_metadata_is_unavailable(self) -> None:
        with patch.object(sketchforge3d, "_distribution_version", side_effect=PackageNotFoundError):
            self.assertEqual(sketchforge3d._read_version(), "1.27.0")


if __name__ == "__main__":
    unittest.main()
