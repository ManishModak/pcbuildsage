from scraper.__main__ import DEFAULT_SWEEP_MIN_RATIO
from scraper.db import sweep_skip_reason


def test_empty_crawl_never_sweeps() -> None:
    # An empty crawl is indistinguishable from an anti-bot block page.
    reason = sweep_skip_reason(found=0, previous_in_stock=200, min_ratio=0.5, force=False)
    assert reason is not None
    assert "no products" in reason


def test_partial_crawl_is_skipped() -> None:
    # 3 of 200 is the degraded-block case the ratio guard exists for.
    reason = sweep_skip_reason(found=3, previous_in_stock=200, min_ratio=0.5, force=False)
    assert reason is not None
    assert "partial crawl" in reason


def test_healthy_crawl_sweeps() -> None:
    assert sweep_skip_reason(found=180, previous_in_stock=200, min_ratio=0.5, force=False) is None


def test_crawl_exactly_at_threshold_sweeps() -> None:
    assert sweep_skip_reason(found=100, previous_in_stock=200, min_ratio=0.5, force=False) is None


def test_first_run_with_no_baseline_sweeps() -> None:
    # Nothing on record yet, so there is no collapse to detect.
    assert sweep_skip_reason(found=1, previous_in_stock=0, min_ratio=0.5, force=False) is None


def test_force_overrides_every_guard() -> None:
    assert sweep_skip_reason(found=0, previous_in_stock=200, min_ratio=0.5, force=True) is None
    assert sweep_skip_reason(found=3, previous_in_stock=200, min_ratio=0.5, force=True) is None


def test_default_ratio_is_half() -> None:
    assert DEFAULT_SWEEP_MIN_RATIO == 0.5
