function loanBlockReason(asset) {
  if (!asset || asset.kind !== 'herramienta') return 'La referencia no está clasificada como herramienta.';
  if (!Number(asset.active)) return 'Pendiente de validación administrativa: la referencia está inactiva.';
  if (asset.asset_status !== 'disponible') {
    const labels = {
      prestada: 'La herramienta ya está prestada.',
      mantenimiento: 'La herramienta tiene estado registrado de mantenimiento.',
      baja: 'La herramienta está dada de baja.'
    };
    return labels[asset.asset_status] || 'La herramienta no está disponible para préstamo.';
  }
  return null;
}

function workshopToolReferences(products, assets) {
  const registered = new Set(assets.map(asset => asset.product_id));
  return products.filter(product => product.kind !== 'consumible' && !registered.has(product.id))
    .map(product => ({ ...product, product_barcode: product.barcode, is_reference: true }));
}

function filterToolAssets(assets, filters = {}) {
  const query = String(filters.query || '').trim().toLocaleLowerCase();
  return assets.filter(asset => {
    const matchesQuery = !query || [
      asset.asset_barcode,
      asset.name,
      asset.sap_code,
      asset.product_barcode,
      asset.module,
      asset.location,
      asset.description
    ].some(value => String(value || '').toLocaleLowerCase().includes(query));
    const matchesModule = !filters.moduleId || String(asset.module_id) === String(filters.moduleId);
    const matchesLocation = !filters.location || asset.location === filters.location;
    const matchesStatus = !filters.status
      || (filters.status === 'validacion' ? !Number(asset.active) || asset.is_reference : asset.asset_status === filters.status);
    return matchesQuery && matchesModule && matchesLocation && matchesStatus;
  });
}

const toolAvailability = { filterToolAssets, loanBlockReason, workshopToolReferences };
if (typeof module !== 'undefined' && module.exports) module.exports = toolAvailability;
if (typeof window !== 'undefined') window.ToolAvailability = toolAvailability;
