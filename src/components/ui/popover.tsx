"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({
  className,
  children,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  collisionPadding = 24,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding">) {
  return (
    <PopoverPrimitive.Portal>
      {/* Anchored to the trigger element automatically (never fixed viewport
          coordinates) — collisionBoundary defaults to Base UI's own
          'clipping-ancestors', which already resolves to the wizard
          dialog's own scrollable container (the trigger lives inside it),
          not just the raw viewport. collisionPadding is the guaranteed gap
          kept from that boundary when flipping/shifting to avoid overlap. */}
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            // Deliberately lighter than a Dialog — smaller radius, thinner
            // border, softer shadow — so this reads as "date picker", not
            // "second modal" (spec item 9).
            "relative isolate z-50 origin-(--transform-origin) rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-md duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
