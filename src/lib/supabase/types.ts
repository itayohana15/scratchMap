// Hand-written to match supabase/migrations/0001_init.sql. Once the
// Supabase project is linked via the CLI, this can be regenerated with:
//   npx supabase gen types typescript --project-id <ref> --schema public
export type Status = "visited" | "planned" | "not_visited";
export type PlaceKind = "hotel" | "restaurant" | "attraction";
export type PlaceSource = "manual" | "google_places";

export interface Database {
  public: {
    Tables: {
      countries: {
        Row: {
          id: string;
          user_id: string | null;
          name: string;
          iso_a2: string;
          iso_a3: string | null;
          status: Status;
          overview: string | null;
          notes: string | null;
          favorite_memory: string | null;
          rating: number | null;
          latitude: number | null;
          longitude: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["countries"]["Row"],
            | "id"
            | "user_id"
            | "status"
            | "iso_a3"
            | "overview"
            | "notes"
            | "favorite_memory"
            | "rating"
            | "latitude"
            | "longitude"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["countries"]["Row"], "name" | "iso_a2">;
        Update: Partial<Database["public"]["Tables"]["countries"]["Insert"]>;
        Relationships: [];
      };
      cities: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string;
          name: string;
          status: Status;
          latitude: number | null;
          longitude: number | null;
          overview: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["cities"]["Row"],
            | "id"
            | "user_id"
            | "status"
            | "latitude"
            | "longitude"
            | "overview"
            | "notes"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["cities"]["Row"], "country_id" | "name">;
        Update: Partial<Database["public"]["Tables"]["cities"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "cities_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
        ];
      };
      country_itineraries: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string;
          iso_a2: string;
          title: string;
          start_date: string | null;
          end_date: string | null;
          days_count: number;
          travelers: number;
          budget: number | null;
          generation_mode: string;
          source: string;
          model: string | null;
          summary: string | null;
          preferences_snapshot: unknown;
          workspace_snapshot: unknown;
          itinerary_days: unknown;
          cost_summary: unknown;
          status: string;
          version: number;
          parent_itinerary_id: string | null;
          manually_edited: boolean;
          archived: boolean;
          generated_at: string;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
          external_key: string | null;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["country_itineraries"]["Row"],
            | "id"
            | "user_id"
            | "start_date"
            | "end_date"
            | "days_count"
            | "travelers"
            | "budget"
            | "generation_mode"
            | "source"
            | "model"
            | "summary"
            | "preferences_snapshot"
            | "workspace_snapshot"
            | "itinerary_days"
            | "cost_summary"
            | "status"
            | "version"
            | "parent_itinerary_id"
            | "manually_edited"
            | "archived"
            | "generated_at"
            | "deleted_at"
            | "created_at"
            | "updated_at"
            | "external_key"
          >
        > &
          Pick<
            Database["public"]["Tables"]["country_itineraries"]["Row"],
            "country_id" | "iso_a2" | "title"
          >;
        Update: Partial<Database["public"]["Tables"]["country_itineraries"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "country_itineraries_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "country_itineraries_parent_itinerary_id_fkey";
            columns: ["parent_itinerary_id"];
            isOneToOne: false;
            referencedRelation: "country_itineraries";
            referencedColumns: ["id"];
          },
        ];
      };
      country_itinerary_versions: {
        Row: {
          id: string;
          itinerary_id: string;
          version: number;
          change_reason: string | null;
          source: string;
          model: string | null;
          snapshot: unknown;
          restored_from_version_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["country_itinerary_versions"]["Row"],
            | "id"
            | "change_reason"
            | "source"
            | "model"
            | "snapshot"
            | "restored_from_version_id"
            | "created_at"
          >
        > &
          Pick<
            Database["public"]["Tables"]["country_itinerary_versions"]["Row"],
            "itinerary_id" | "version"
          >;
        Update: Partial<Database["public"]["Tables"]["country_itinerary_versions"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "country_itinerary_versions_itinerary_id_fkey";
            columns: ["itinerary_id"];
            isOneToOne: false;
            referencedRelation: "country_itineraries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "country_itinerary_versions_restored_from_version_id_fkey";
            columns: ["restored_from_version_id"];
            isOneToOne: false;
            referencedRelation: "country_itinerary_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      trips: {
        Row: {
          id: string;
          user_id: string | null;
          name: string;
          start_date: string | null;
          end_date: string | null;
          budget: number | null;
          cost: number | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["trips"]["Row"],
            | "id"
            | "user_id"
            | "start_date"
            | "end_date"
            | "budget"
            | "cost"
            | "notes"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["trips"]["Row"], "name">;
        Update: Partial<Database["public"]["Tables"]["trips"]["Insert"]>;
        Relationships: [];
      };
      trip_cities: {
        Row: {
          id: string;
          trip_id: string;
          city_id: string;
          arrival_date: string | null;
          departure_date: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["trip_cities"]["Row"],
            "id" | "arrival_date" | "departure_date" | "notes" | "created_at"
          >
        > &
          Pick<Database["public"]["Tables"]["trip_cities"]["Row"], "trip_id" | "city_id">;
        Update: Partial<Database["public"]["Tables"]["trip_cities"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "trip_cities_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "trip_cities_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
        ];
      };
      photos: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string | null;
          city_id: string | null;
          trip_id: string | null;
          itinerary_id: string | null;
          day_id: string | null;
          place_id: string | null;
          favorite: boolean;
          storage_path: string;
          caption: string | null;
          taken_at: string | null;
          sort_order: number;
          width: number | null;
          height: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["photos"]["Row"],
            | "id"
            | "user_id"
            | "country_id"
            | "city_id"
            | "trip_id"
            | "itinerary_id"
            | "day_id"
            | "place_id"
            | "favorite"
            | "caption"
            | "taken_at"
            | "sort_order"
            | "width"
            | "height"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["photos"]["Row"], "storage_path">;
        Update: Partial<Database["public"]["Tables"]["photos"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "photos_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_itinerary_id_fkey";
            columns: ["itinerary_id"];
            isOneToOne: false;
            referencedRelation: "country_itineraries";
            referencedColumns: ["id"];
          },
        ];
      };
      trip_ratings: {
        Row: {
          id: string;
          itinerary_id: string;
          overall: number | null;
          food: number | null;
          culture: number | null;
          nature: number | null;
          attractions: number | null;
          nightlife: number | null;
          transportation: number | null;
          value_for_money: number | null;
          safety: number | null;
          cleanliness: number | null;
          tourist_convenience: number | null;
          locals_hospitality: number | null;
          shopping: number | null;
          weather: number | null;
          would_return: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["trip_ratings"]["Row"],
            | "id"
            | "overall"
            | "food"
            | "culture"
            | "nature"
            | "attractions"
            | "nightlife"
            | "transportation"
            | "value_for_money"
            | "safety"
            | "cleanliness"
            | "tourist_convenience"
            | "locals_hospitality"
            | "shopping"
            | "weather"
            | "would_return"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["trip_ratings"]["Row"], "itinerary_id">;
        Update: Partial<Database["public"]["Tables"]["trip_ratings"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "trip_ratings_itinerary_id_fkey";
            columns: ["itinerary_id"];
            isOneToOne: true;
            referencedRelation: "country_itineraries";
            referencedColumns: ["id"];
          },
        ];
      };
      country_ratings: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string;
          nature: number | null;
          food: number | null;
          transportation: number | null;
          safety: number | null;
          cleanliness: number | null;
          value_for_money: number | null;
          nightlife: number | null;
          friendliness: number | null;
          overall: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["country_ratings"]["Row"],
            | "id"
            | "user_id"
            | "nature"
            | "food"
            | "transportation"
            | "safety"
            | "cleanliness"
            | "value_for_money"
            | "nightlife"
            | "friendliness"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["country_ratings"]["Row"], "country_id">;
        Update: Partial<Database["public"]["Tables"]["country_ratings"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "country_ratings_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: true;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
        ];
      };
      places: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string | null;
          city_id: string | null;
          kind: PlaceKind;
          name: string;
          address: string | null;
          latitude: number | null;
          longitude: number | null;
          notes: string | null;
          rating: number | null;
          source: PlaceSource;
          google_place_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["places"]["Row"],
            | "id"
            | "user_id"
            | "country_id"
            | "city_id"
            | "address"
            | "latitude"
            | "longitude"
            | "notes"
            | "rating"
            | "source"
            | "google_place_id"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["places"]["Row"], "kind" | "name">;
        Update: Partial<Database["public"]["Tables"]["places"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "places_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "places_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_recommendations: {
        Row: {
          id: string;
          user_id: string | null;
          iso_a2: string;
          content: unknown;
          model: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["ai_recommendations"]["Row"],
            "id" | "user_id" | "created_at" | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["ai_recommendations"]["Row"], "iso_a2" | "content" | "model">;
        Update: Partial<Database["public"]["Tables"]["ai_recommendations"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
