import {
  doc,
  collection,
  updateDoc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc
} from 'firebase/firestore'

import { db } from '../firebase'
import Date from '../utils/Date'

/**
 * Normalize wallet address (case-insensitive key)
 */
function normalizeAddress(address) {
  if (!address) return address
  return address.toLowerCase().trim()
}

/**
 * Get all polyscores
 */
async function getAll() {
  return new Promise(async (resolve, reject) => {
    try {
      const collectionRef = collection(db, 'polyscore')
      const querySnapshot = await getDocs(collectionRef)

      let list = []
      querySnapshot.forEach((docSnap) => {
        list.push({ id: docSnap.id, ...docSnap.data() })
      })

      resolve(list)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Get polyscore by wallet address (case-insensitive)
 */
async function getPolyscore(address) {
  return new Promise(async (resolve, reject) => {
    try {
      const normalized = normalizeAddress(address)
      const docRef = doc(db, 'polyscore', normalized)
      const querySnapshot = await getDoc(docRef)

      resolve(querySnapshot.exists() ? querySnapshot.data() : null)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Create polyscore (or update if already exists)
 */
async function create(address, item) {
  const normalized = normalizeAddress(address)

  const existing = await getPolyscore(normalized)
  if (existing) {
    return update(normalized, item)
  }

  return new Promise(async (resolve, reject) => {
    try {
      const docRef = doc(db, 'polyscore', normalized)

      const payload = {
        ...item,
        id: normalized,
        address: normalized,          // canonical address
        originalAddress: address,     // optional, human-readable
        dateCreated: new Date().toJSON()
      }

      await setDoc(docRef, payload)
      resolve(payload)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Update polyscore (case-insensitive)
 */
async function update(address, item) {
  return new Promise(async (resolve, reject) => {
    try {
      const normalized = normalizeAddress(address)
      const docRef = doc(db, 'polyscore', normalized)

      await updateDoc(docRef, item)
      resolve(item)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Delete polyscore by wallet address (case-insensitive)
 */
async function deleteScore(address) {
  return new Promise(async (resolve, reject) => {
    try {
      const normalized = normalizeAddress(address)
      const docRef = doc(db, 'polyscore', normalized)

      await deleteDoc(docRef)
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

export {
  getAll,
  getPolyscore,
  create,
  update,
  deleteScore
}
