<template>
  <!-- 1. BOTÓN DE AMBIENTES (Alineado a la izquierda según image_516efb.jpg) -->
  <div class="absolute-top-left container-ambientes-left">
    <q-btn-dropdown
      unelevated
      color="green-9"
      icon="map"
      label="Ambientes"
      class="text-weight-bold text-capitalize q-px-md btn-ambientes-style"
      content-class="shadow-5 dropdown-filtros-ambientes"
    >
      <div class="q-pa-sm bg-white" style="width: 280px;">
        <!-- Buscador interno -->
        <q-input
          v-model="filterText"
          dense
          outlined
          placeholder="Filtrar ambientes..."
          class="q-mb-sm"
          color="green-9"
        >
          <template v-slot:prepend>
            <q-icon name="search" size="xs" />
          </template>
          <template v-slot:append v-if="filterText">
            <q-icon name="close" size="xs" class="cursor-pointer" @click="filterText = ''" />
          </template>
        </q-input>

        <!-- Lista filtrada -->
        <q-list separator class="scroll" style="max-height: 250px;">
          <q-item
            v-for="ambiente in filteredAmbientes"
            :key="ambiente._id"
            clickable
            v-close-popup
            @click="seleccionarAmbiente(ambiente)"
            class="q-py-sm rounded-borders"
          >
            <q-item-section avatar class="min-width-icon-ambiente">
              <q-icon name="room" color="green-9" size="18px" />
            </q-item-section>
            
            <q-item-section>
              <q-item-label class="text-body2 text-weight-medium text-grey-9">
                {{ ambiente.name }} 
                <span :class="ambiente.status === 0 ? 'text-grey-7 text-weight-normal' : 'text-red-7 text-weight-medium'">
                  ({{ ambiente.status === 0 ? 'Disponible' : 'Ocupado' }})
                </span>
              </q-item-label>
            </q-item-section>
          </q-item>

          <!-- Si no hay resultados -->
          <q-item v-if="filteredAmbientes.length === 0">
            <q-item-section class="text-center text-caption text-grey-6 q-py-md">
              No se encontraron ambientes.
            </q-item-section>
          </q-item>
        </q-list>
      </div>
    </q-btn-dropdown>
  </div>

  <!-- 2. BOTONES DE ACCIÓN PRINCIPALES (Alineados a la derecha según image_510902.png) -->
  <div class="absolute-top-right row items-center q-gutter-x-sm q-pa-sm container-action-buttons">
    
    <div v-if="isSynced" class="row items-center text-caption text-green-9 q-mr-sm text-weight-medium">
      <q-icon name="cloud_done" size="18px" class="q-mr-xs" />
      <span>Sincronizado</span>
    </div>
    
    <q-btn 
      v-if="isLeader"
      unelevated 
      padding="xs sm"
      color="indigo-10" 
      class="text-white btn-action-header" 
      @click="$emit('save-template')"
    >
      <div class="column items-center">
        <q-icon name="save" size="18px" />
        <span class="text-caption-custom">Guardar</span>
      </div>
      <q-tooltip class="bg-indigo-10 text-weight-bold">Guardar esta planeación como plantilla sugerida</q-tooltip>
    </q-btn>

    <q-btn 
      v-if="isLeader"
      unelevated 
      padding="xs sm"
      color="red-8" 
      class="text-white btn-action-header"
      :disable="!hasTemplate" 
      @click="$emit('import-template')"
    >
      <div class="column items-center">
        <q-icon name="download" size="18px" />
        <span class="text-caption-custom">Importar</span>
      </div>
      <q-tooltip class="bg-red-9 text-weight-bold">Importar actividades sugeridas desde la planilla</q-tooltip>
    </q-btn>

    <q-btn 
      unelevated 
      padding="xs sm"
      color="green-8" 
      class="text-white btn-action-header" 
      @click="$emit('export-excel')"
    >
      <div class="column items-center">
        <q-icon name="description" size="18px" />
        <span class="text-caption-custom">Excel</span>
      </div>
      <q-tooltip class="bg-green-9 text-weight-bold">Exportar a Excel</q-tooltip>
    </q-btn>


    <q-btn 
      unelevated 
      padding="xs sm"
      color="deep-orange-6" 
      class="text-white btn-action-header" 
      @click="$emit('show-preview')"
    >
      <div class="column items-center">
        <q-icon name="calendar_month" size="18px" />
        <span class="text-caption-custom">Previa</span>
      </div>
      <q-tooltip class="bg-deep-orange-8 text-weight-bold">Previsualizar programación</q-tooltip>
    </q-btn>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { EnvironmentService } from '../../services/environment.service';

const $q = useQuasar();

defineProps({
  isSynced: { type: Boolean, default: false },
  isLeader: { type: Boolean, default: false },
  hasTemplate: { type: Boolean, default: false }
});

const emit = defineEmits([
  'save-template',
  'import-template',
  'clear-plan',
  'export-excel',
  'show-preview',
  'seleccionarAmbiente'
]);

const filterText = ref('');
const ambientes = ref([]);

const filteredAmbientes = computed(() => {
  if (!filterText.value) return ambientes.value;
  const lowerCaseFilter = filterText.value.toLowerCase();
  return ambientes.value.filter(ambiente =>
    ambiente.name.toLowerCase().includes(lowerCaseFilter)
  );
});

onMounted(async () => {
  try {
    const data = await EnvironmentService.getEnvironments();
    ambientes.value = data;
  } catch (error) {
    console.error("Error loading environments:", error);
    $q.notify({ message: 'No se pudo cargar la lista de ambientes de formación.', color: 'orange-8', icon: 'warning' });
  }
});

const seleccionarAmbiente = (ambiente) => {
  emit('seleccionarAmbiente', ambiente);
};
</script>

<style scoped>

.container-ambientes-left {
  top: 70px;
  left: 100px;
  z-index: 10;
}

.btn-ambientes-style {
  border-radius: 8px; 
  font-size: 14px; 
  height: 38px;
}

/* Contenedor Derecho (Botones de Acción) */
.container-action-buttons {
  top: 60px;      
  right: 24px;     
  z-index: 10;
}

.btn-action-header {
  min-width: 60px;
  max-height: 48px;
  border-radius: 6px;
}

.text-caption-custom {
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  margin-top: 2px;
}

/* Estilos de limpieza para el menú desplegable */
.dropdown-filtros-ambientes {
  border-radius: 12px !important;
  border: 1px solid #e0e0e0;
}

.min-width-icon-ambiente {
  min-width: 30px !important;
  padding-right: 4px;
}
</style>