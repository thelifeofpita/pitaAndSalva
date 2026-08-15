#!/usr/bin/env python
"""Foreground (subject) mask extraction using macOS Vision framework.

Usage: seg.py IN.png OUT_mask.png
"""
import sys
import Quartz
import Vision
from Foundation import NSURL, NSData
import objc


def mask_for(path_in, path_out):
    url = NSURL.fileURLWithPath_(path_in)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        raise SystemExit("cannot read " + path_in)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, {})
    req = Vision.VNGenerateForegroundInstanceMaskRequest.alloc().init()
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise SystemExit("vision failed: %s" % err)
    results = req.results()
    if not results:
        # empty mask
        raise SystemExit("NOFG")
    obs = results[0]
    inst = obs.allInstances()
    buf, err = obs.generateScaledMaskForImageForInstances_fromRequestHandler_error_(
        inst, handler, None
    )
    if buf is None:
        raise SystemExit("mask failed: %s" % err)

    ci = Quartz.CIImage.imageWithCVPixelBuffer_(buf)
    ctx = Quartz.CIContext.context()
    out_cg = ctx.createCGImage_fromRect_(ci, ci.extent())
    dest_url = NSURL.fileURLWithPath_(path_out)
    dest = Quartz.CGImageDestinationCreateWithURL(dest_url, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(dest, out_cg, None)
    Quartz.CGImageDestinationFinalize(dest)


if __name__ == "__main__":
    mask_for(sys.argv[1], sys.argv[2])
