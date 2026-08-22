"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Sparkles } from "lucide-react";

import { AttractionActionBar } from "@/components/country/attraction-modal/action-bar";
import { DescriptionSection } from "@/components/country/attraction-modal/description";
import { AttractionHero } from "@/components/country/attraction-modal/hero";
import { ItineraryIntegrationSection } from "@/components/country/attraction-modal/itinerary-integration";
import { NearbySection } from "@/components/country/attraction-modal/nearby";
import { PersonalLogSection } from "@/components/country/attraction-modal/personal-log";
import { QuickInfoGrid } from "@/components/country/attraction-modal/quick-info-grid";
import { RecommendationFeedbackButtons } from "@/components/country/recommendation-feedback-buttons";
import { SafetySection } from "@/components/country/attraction-modal/safety";
import { TravelInfoSection } from "@/components/country/attraction-modal/travel-info";
import { useAttractionModalData } from "@/components/country/attraction-modal/use-attraction-modal-data";
import type { useCountryTripWorkspace } from "@/components/country/use-country-trip-workspace";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePreferenceProfile } from "@/lib/queries/preference-profile";
import { useAllRecommendationFeedback } from "@/lib/queries/recommendation-feedback";
import {
  aggregateFeedbackByPlace,
  computeRecommendationScore,
  explainRecommendation,
} from "@/lib/preference-learning";
import { buildMapLink } from "@/lib/trip-workspace";
import type { CountryTripWorkspaceState, TripRecommendation } from "@/lib/trip-workspace";

type WorkspaceController = ReturnType<typeof useCountryTripWorkspace>;

type ModalTab = "info" | "trip" | "safety";

const MODAL_TAB_LABELS: Record<ModalTab, string> = {
  info: "פרטים",
  trip: "מסלול וטיול",
  safety: "בטיחות וסביבה",
};

interface AttractionModalProps {
  recommendation: TripRecommendation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: CountryTripWorkspaceState;
  actions: WorkspaceController["actions"];
  selectedDayId: string;
  countryName: string;
  isoA2: string;
}

export function AttractionModal({
  recommendation,
  open,
  onOpenChange,
  workspace,
  actions,
  selectedDayId,
  countryName,
  isoA2,
}: AttractionModalProps) {
  const { placement, previousItem, wikipedia, nearby, drivingRoute } = useAttractionModalData(
    recommendation,
    workspace
  );
  const [activeTab, setActiveTab] = useState<ModalTab>("info");
  const { data: preferenceProfile } = usePreferenceProfile();
  const { data: recommendationFeedback = [] } = useAllRecommendationFeedback();

  useEffect(() => {
    if (open) setActiveTab("info");
  }, [open, recommendation?.id]);

  if (!recommendation) return null;

  const explanation = explainRecommendation(
    recommendation,
    computeRecommendationScore(recommendation, {
      explicitPreferences: preferenceProfile?.explicit_preferences ?? {},
      inferredPreferences: {},
      feedbackByPlaceKey: aggregateFeedbackByPlace(recommendationFeedback),
      alreadyVisited: new Map(),
    }),
    preferenceProfile?.explicit_preferences ?? {}
  );

  const isSaved = workspace.recommendations.some((item) => item.id === recommendation.id);
  const isInItinerary = placement != null;
  const isVisited = placement?.item.completed === true;

  function toggleSave() {
    if (!recommendation) return;
    if (isSaved) {
      actions.removeRecommendation(recommendation.id);
    } else {
      actions.addOrUpdateRecommendation(recommendation);
      toast.success("נשמר במועדפים");
    }
  }

  function addToItinerary() {
    if (!recommendation) return;
    if (!selectedDayId) {
      toast.error("אין עדיין ימים במסלול — הוסיפו יום בטאב המסלול");
      return;
    }
    actions.addRecommendationToDay(selectedDayId, recommendation);
    toast.success("נוסף למסלול");
  }

  function toggleVisited() {
    if (!recommendation) return;
    if (placement) {
      actions.updateItem(placement.day.id, placement.item.id, { completed: !placement.item.completed });
      return;
    }
    if (!selectedDayId) {
      toast.error("אין עדיין ימים במסלול — הוסיפו יום בטאב המסלול");
      return;
    }
    actions.markRecommendationVisited(selectedDayId, recommendation);
    toast.success("סומן כביקור שבוצע");
  }

  const mapSearchLink =
    recommendation.mapLink || buildMapLink(recommendation.name, recommendation.lat, recommendation.lon);
  const directionsLink =
    recommendation.lat != null && recommendation.lon != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${recommendation.lat},${recommendation.lon}`
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[min(94vw,1100px)] flex-col gap-0 overflow-hidden rounded-[2rem] border border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur sm:max-w-5xl">
        <DialogTitle className="sr-only">{recommendation.name}</DialogTitle>

        <div className="shrink-0 border-b border-border/60 p-3 sm:p-4">
          <AttractionHero
            recommendation={recommendation}
            countryName={countryName}
            isSaved={isSaved}
            isVisited={isVisited}
            isInItinerary={isInItinerary}
            onToggleSave={toggleSave}
            onAddToItinerary={addToItinerary}
            onToggleVisited={toggleVisited}
          />
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as ModalTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="shrink-0 border-b border-border/60 px-4 pt-2 sm:px-6">
            <TabsList variant="line" className="h-auto w-full justify-start gap-1 p-0">
              {(Object.keys(MODAL_TAB_LABELS) as ModalTab[]).map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="rounded-full px-3.5 py-2 text-sm text-foreground/70 after:hidden data-active:bg-primary data-active:font-semibold data-active:text-primary-foreground"
                >
                  {MODAL_TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <TabsContent value="info" className="space-y-4 pt-0">
              <QuickInfoGrid recommendation={recommendation} />
              <DescriptionSection
                shortDescription={recommendation.shortDescription}
                wikipedia={wikipedia.data}
                wikipediaLoading={wikipedia.isLoading}
              />
              <div className="section-card space-y-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">למה זה מתאים לי</p>
                  </div>
                  <RecommendationFeedbackButtons place={recommendation} category={recommendation.category} tripId={null} />
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{explanation}</p>
              </div>
            </TabsContent>

            <TabsContent value="trip" className="space-y-4 pt-0">
              <ItineraryIntegrationSection
                placement={placement}
                onAddToItinerary={addToItinerary}
                onMoveEarlier={() =>
                  placement && actions.moveItem(placement.day.id, placement.item.id, "up")
                }
                onMoveLater={() =>
                  placement && actions.moveItem(placement.day.id, placement.item.id, "down")
                }
                onDuplicate={() => placement && actions.duplicateItem(placement.day.id, placement.item.id)}
                onRemove={() => placement && actions.removeItem(placement.day.id, placement.item.id)}
              />

              <TravelInfoSection
                previousItem={previousItem}
                drivingRoute={drivingRoute.data}
                drivingRouteLoading={drivingRoute.isLoading}
              />

              {placement && isVisited && (
                <PersonalLogSection
                  item={placement.item}
                  photos={workspace.memories.filter((memory) => memory.relatedItemId === placement.item.id)}
                  onUpdate={(patch) => actions.updateItem(placement.day.id, placement.item.id, patch)}
                />
              )}
            </TabsContent>

            <TabsContent value="safety" className="space-y-4 pt-0">
              <SafetySection isoA2={isoA2} />
              <NearbySection places={nearby.data?.places} isLoading={nearby.isLoading} />
            </TabsContent>
          </div>
        </Tabs>

        <AttractionActionBar
          isSaved={isSaved}
          isVisited={isVisited}
          isInItinerary={isInItinerary}
          mapSearchLink={mapSearchLink || null}
          directionsLink={directionsLink}
          shareTitle={recommendation.name}
          onAddToItinerary={addToItinerary}
          onToggleSave={toggleSave}
          onToggleVisited={toggleVisited}
        />
      </DialogContent>
    </Dialog>
  );
}
