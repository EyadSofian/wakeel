"""The parser runs without GPU hardware or proprietary accelerator distributions."""
import importlib.metadata as metadata

import torch


def test_parser_uses_the_cpu_runtime() -> None:
    assert torch.version.cuda is None
    accelerator_packages = [
        dist.metadata["Name"]
        for dist in metadata.distributions()
        if dist.metadata["Name"].lower().startswith(("nvidia-", "cuda-", "triton"))
    ]
    assert accelerator_packages == []
